/**
 * Shared combo (model combo) handling with fallback support
 */

import { checkFallbackError, formatRetryAfter } from "./accountFallback.js";
import { unavailableResponse } from "../utils/error.js";
import { getProviderConnections } from "@/lib/localDb";
import { getModelInfo } from "@/sse/services/model.js";
import { getIntegratorFromHeaders, providerCooldowns } from "@/sse/services/auth.js";
import { updateNimModelHealth } from "./nvidiaDiscovery.js";

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map();

function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function rotateModelsFromIndex(models, currentIndex) {
  const rotatedModels = [...models];
  for (let i = 0; i < currentIndex; i++) {
    const moved = rotatedModels.shift();
    rotatedModels.push(moved);
  }
  return rotatedModels;
}

/**
 * Get rotated model list based on strategy
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - "fallback" or "round-robin"
 * @param {number|string} [stickyLimit=1] - Requests per combo model before switching
 * @returns {string[]} Rotated models array
 */
export function getRotatedModels(models, comboName, strategy, stickyLimit = 1) {
  if (!models || models.length <= 1 || strategy !== "round-robin") {
    return models;
  }

  const rotationKey = comboName || "__default__";
  const normalizedStickyLimit = normalizeStickyLimit(stickyLimit);
  const existingState = comboRotationState.get(rotationKey);
  const state = typeof existingState === "number"
    ? { index: existingState, consecutiveUseCount: 0 }
    : (existingState || { index: 0, consecutiveUseCount: 0 });

  const currentIndex = state.index % models.length;
  const rotatedModels = rotateModelsFromIndex(models, currentIndex);
  const nextUseCount = state.consecutiveUseCount + 1;

  if (nextUseCount >= normalizedStickyLimit) {
    comboRotationState.set(rotationKey, {
      index: (currentIndex + 1) % models.length,
      consecutiveUseCount: 0,
    });
  } else {
    comboRotationState.set(rotationKey, {
      index: currentIndex,
      consecutiveUseCount: nextUseCount,
    });
  }

  return rotatedModels;
}

// In-memory cache for recent latencies: modelStr -> array of numbers
const modelRecentLatencies = new Map();

// Map to store session affinity: sessionKey -> { modelStr, lastAccessAt }
export const sessionModelLocks = new Map();
const MAX_SESSION_LOCKS = 5000;
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes lease
let lastLockCleanupAt = 0;
const LOCK_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute throttle

/**
 * Extracts a conversation or session ID from headers or body metadata
 * to enable session-sticky affinity routing.
 * 
 * @param {Object} body - The request body
 * @param {Object|Headers} headers - The request headers
 * @returns {string|null} The session/conversation identifier
 */
function extractSessionId(body, headers) {
  if (headers) {
    const getHeader = (key) => {
      if (typeof headers.get === "function") return headers.get(key);
      return headers[key] || headers[key.toLowerCase()];
    };

    const headerKeys = [
      "x-conversation-id",
      "copilot-conversation-id",
      "x-session-id",
      "x-request-id"
    ];
    for (const key of headerKeys) {
      const val = getHeader(key);
      if (val) return val;
    }
  }

  if (body) {
    if (body.conversation_id) return body.conversation_id;
    if (body.session_id) return body.session_id;
    if (body.metadata?.conversation_id) return body.metadata.conversation_id;
    if (body.metadata?.session_id) return body.metadata.session_id;
  }

  return null;
}

/**
 * Classifies the task type (fast, coding, agent, reasoning, general)
 * based on the active model name/combo requested, or properties of the request body.
 * 
 * @param {string} modelStr - The requested model/combo name
 * @param {Object} body - The request body containing tools, reasoning configurations, etc.
 * @returns {string} The classified task type ("fast", "coding", "agent", "reasoning", "general")
 */
export function classifyTask(modelStr, body) {
  const cleanModel = (modelStr || "").toLowerCase();
  
  // 1. Check model name or combo name suffixes
  if (cleanModel.includes("fast")) return "fast";
  if (cleanModel.includes("coding")) return "coding";
  if (cleanModel.includes("agent")) return "agent";
  if (cleanModel.includes("reasoning")) return "reasoning";

  // 2. Inspect request body for explicit capability needs
  // - If tools/functions are provided, it requires agentic/tool capabilities
  if (body?.tools && body.tools.length > 0) return "agent";
  // - If reasoning effort is specified, it represents a reasoning task
  if (body?.reasoning_effort || body?.reasoning?.effort) return "reasoning";

  return "general";
}

/**
 * Weighted capability matrix mapping models to suitability scores (0.0 to 1.0) per task class.
 * This determines how well a model fits a specific task.
 */
export const TASK_CAPABILITY_SCORES = {
  coding: {
    "claude-3.5-sonnet": 1.0,
    "claude-sonnet-4.6": 1.0,
    "gpt-4o": 0.9,
    "gpt-4.1": 0.9,
    "gpt-5-mini": 0.8,
    "gpt-4o-mini": 0.7,
    "claude-haiku-4.5": 0.6,
    "gemini-3.5-flash": 0.7
  },
  reasoning: {
    "claude-3.5-opus": 1.0,
    "claude-opus-4.8": 1.0,
    "gpt-5.5": 0.95,
    "gpt-5.4": 0.95,
    "gemini-3.5-flash": 0.7
  },
  fast: {
    "gpt-5-mini": 1.0,
    "gpt-4o-mini": 0.9,
    "claude-haiku-4.5": 0.8,
    "gemini-3.5-flash": 0.8,
    "gpt-4o": 0.6
  },
  agent: {
    "gpt-5.3-codex": 1.0,
    "gpt-5.2-codex": 0.95,
    "gpt-4o": 0.8,
    "claude-sonnet-4.6": 0.9
  },
  general: {
    "claude-sonnet-4.6": 1.0,
    "gpt-4o": 0.9,
    "gpt-4.1": 0.85,
    "gpt-5-mini": 0.8,
    "gpt-4o-mini": 0.7,
    "claude-haiku-4.5": 0.7
  }
};

/**
 * Computes a weighted capability score (0.0 to 1.0) for a given model and task class
 * by searching the suitability matrix and provider_models registry for NIM models.
 *
 * @param {string} taskClass - The classified task type ("fast", "coding", etc.)
 * @param {string} modelId - The model identifier to query suitability for
 * @returns {number} The capability score between 0.0 and 1.0 (defaults to 0.5 if unknown)
 */
export function getCapabilityScore(taskClass, modelId) {
  const cleanModel = (modelId || "").toLowerCase();
  const taskScores = TASK_CAPABILITY_SCORES[taskClass] || TASK_CAPABILITY_SCORES.general;

  for (const [key, val] of Object.entries(taskScores)) {
    if (cleanModel.includes(key)) return val;
  }

  // NIM model capability from category alignment (Phase 3 auto-categorization)
  if (cleanModel.startsWith("nvidia/") || cleanModel.includes("nim")) {
    const categoryMappings = {
      coding: { coding: 1.0, agent: 0.85, reasoning: 0.7, fast: 0.5 },
      reasoning: { reasoning: 1.0, agent: 0.75, coding: 0.5, fast: 0.3 },
      fast: { fast: 1.0, coding: 0.5, reasoning: 0.3 },
      agent: { agent: 1.0, reasoning: 0.8, coding: 0.7, fast: 0.4 },
    };
    const mappings = categoryMappings[taskClass] || {};
    for (const [cat, score] of Object.entries(mappings)) {
      if (cleanModel.includes(cat)) return score;
    }
    if (cleanModel.includes("nim-coding")) return mappings.coding || 0.85;
    if (cleanModel.includes("nim-fast")) return mappings.fast || 0.85;
    if (cleanModel.includes("nim-agent")) return mappings.agent || 0.85;
    if (cleanModel.includes("nim-reasoning")) return mappings.reasoning || 0.85;
  }

  return 0.5;
}

/**
 * Sort models in a combo dynamically based on score
 * score = availability * 30 + health * 25 + capability * 25 + latency * 10 + priority * 10 + stabilityBonus
 */
/**
 * Sort models in a combo dynamically based on score
 * score = availability * 30 + health * 25 + capability * 25 + latency * 10 + priority * 10 + stabilityBonus
 */
async function sortModelsByScore(models, taskClass = "general", activeLockModel = null, integrator = "vscode-chat") {
  const providerConnectionsCache = new Map();
  const modelInfoCache = new Map();

  const scoredModels = await Promise.all(
    models.map(async (modelStr) => {
      let score = 0;
      let availability = 0;
      let health = 1.0;
      let capabilityScore = 0.5; // default
      let latencyScore = 0.5; // default
      let priorityScore = 0.5; // default
      let stabilityBonus = 0;

      try {
        let modelInfo = modelInfoCache.get(modelStr);
        if (!modelInfo) {
          modelInfo = await getModelInfo(modelStr);
          modelInfoCache.set(modelStr, modelInfo);
        }

        if (modelInfo && modelInfo.provider) {
          const { provider, model } = modelInfo;

          let connections = providerConnectionsCache.get(provider);
          if (!connections) {
            connections = await getProviderConnections({ provider, isActive: true });
            providerConnectionsCache.set(provider, connections);
          }

          // Calculate capability score using weighted map
          capabilityScore = getCapabilityScore(taskClass, model);

          const validConns = connections.filter((conn) => {
            const key = `modelLock_${model}`;
            const expiry = conn[key] || conn.modelLock___all;
            if (expiry && new Date(expiry).getTime() > Date.now()) return false;

            if (provider === "github") {
              const cache = conn.availableModelsByIntegrator || {};
              const modelsForIntegrator = cache[integrator] || conn.availableModels;
              if (modelsForIntegrator) {
                const cleanModel = model.startsWith("github/") ? model.slice(7) : model;
                const hasModel = modelsForIntegrator.some(m => m.id === cleanModel || m.id === model);
                if (!hasModel) return false;
              }
            }
            return true;
          });

          // Check if provider is under outage cooldown (Provider Health Layer)
          const isProviderCoolingDown = providerCooldowns && providerCooldowns.has(provider) && providerCooldowns.get(provider) > Date.now();

          if (isProviderCoolingDown) {
            health = 0.0;
          } else if (validConns.length > 0) {
            availability = 1.0;
            const conn = validConns[0];

            const mh = conn.modelHealth?.[model];
            if (mh) {
              if (mh.disabledUntil && new Date(mh.disabledUntil).getTime() > Date.now()) {
                health = 0.0;
              } else {
                const failCount = mh.failCount || 0;
                health = Math.max(0.0, 1.0 - failCount * 0.33);
              }
            }

            const avgLatency = conn.averageLatency || 1000;
            latencyScore = 1.0 - Math.min(avgLatency / 5000, 1.0);

            const priority = conn.priority || 5;
            priorityScore = Math.max(0.0, 1.0 - (priority - 1) * 0.1);
          }
        }
      } catch (error) {
        console.error(`Error scoring model ${modelStr}:`, error);
      }

      // Stability bonus (+5 points) if it matches the current session model lock
      if (activeLockModel === modelStr) {
        stabilityBonus = 5.0;
      }

      score = (availability * 30) + (health * 25) + (capabilityScore * 25) + (latencyScore * 15) + (priorityScore * 5) + stabilityBonus;
      return {
        modelStr,
        score,
        details: {
          availability: availability * 30,
          health: health * 25,
          capability: capabilityScore * 25,
          latency: latencyScore * 15,
          priority: priorityScore * 5,
          stabilityBonus
        }
      };
    })
  );

  scoredModels.sort((a, b) => b.score - a.score);

  return {
    sortedModels: scoredModels.map((item) => item.modelStr),
    explanationMap: Object.fromEntries(scoredModels.map(item => [item.modelStr, {
      selectedModel: item.modelStr,
      taskClass,
      availability: Math.round(item.details.availability * 100) / 100,
      health: Math.round(item.details.health * 100) / 100,
      capability: Math.round(item.details.capability * 100) / 100,
      latency: Math.round(item.details.latency * 100) / 100,
      priority: Math.round(item.details.priority * 100) / 100,
      stabilityBonus: Math.round(item.details.stabilityBonus * 100) / 100,
      score: Math.round(item.score * 100) / 100
    }]))
  };
}

/**
 * Reset in-memory rotation state when combo/settings change
 * @param {string} [comboName] - Combo name to reset; omit to clear all
 */
export function resetComboRotation(comboName) {
  if (comboName) comboRotationState.delete(comboName);
  else comboRotationState.clear();
}

/**
 * Get combo models from combos data
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of models or null if not a combo
 */
export function getComboModelsFromData(modelStr, combosData) {
  // Don't check if it's in provider/model format
  if (modelStr.includes("/")) return null;
  
  // Handle both array and object formats
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);
  
  const combo = combos.find(c => c.name === modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

/**
 * Handle combo chat with fallback
 * @param {Object} options
 * @param {Object} options.body - Request body
 * @param {string[]} options.models - Array of model strings to try
 * @param {Function} options.handleSingleModel - Function to handle single model: (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger object
 * @param {string} [options.comboName] - Name of the combo (for round-robin tracking)
 * @param {string} [options.comboStrategy] - Strategy: "fallback" or "round-robin" or "score"
 * @param {number|string} [options.comboStickyLimit=1] - Requests per combo model before switching
 * @returns {Promise<Response>}
 */
export async function handleComboChat({ body, models, handleSingleModel, log, comboName, comboStrategy, comboStickyLimit = 1, headers = null }) {
  const sessionId = extractSessionId(body, headers);
  const taskClass = classifyTask(comboName, body);
  const sessionKey = sessionId ? `${sessionId}:${taskClass}` : null;

  // Clean expired locks (throttled to run at most once per minute to avoid O(N) scan overhead)
  if (sessionKey) {
    const now = Date.now();
    if (now - lastLockCleanupAt > LOCK_CLEANUP_INTERVAL_MS) {
      lastLockCleanupAt = now;
      for (const [key, lock] of sessionModelLocks.entries()) {
        if (now - lock.lastAccessAt > SESSION_TTL_MS) {
          sessionModelLocks.delete(key);
        }
      }
    }
  }

  // Get active session locked model
  const activeLock = sessionKey ? sessionModelLocks.get(sessionKey) : null;
  const activeLockModel = activeLock ? activeLock.modelStr : null;

  // Apply rotation or score strategy
  let rotatedModels;
  let explanationMap = null;
  if (comboStrategy === "score") {
    const integrator = getIntegratorFromHeaders(headers);
    const scoreResult = await sortModelsByScore(models, taskClass, activeLockModel, integrator);
    rotatedModels = scoreResult.sortedModels;
    explanationMap = scoreResult.explanationMap;
  } else {
    rotatedModels = getRotatedModels(models, comboName, comboStrategy, comboStickyLimit);
    explanationMap = Object.fromEntries(rotatedModels.map(m => [m, {
      selectedModel: m,
      taskClass,
      strategy: comboStrategy
    }]));
  }
  
  let lastError = null;
  let earliestRetryAfter = null;
  let lastStatus = null;

  for (let i = 0; i < rotatedModels.length; i++) {
    const modelStr = rotatedModels[i];
    const exp = explanationMap?.[modelStr];
    log.info("COMBO", `Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}${exp ? ` (score: ${exp.score}, capability: ${exp.capability}, health: ${exp.health})` : ""}`);

    try {
      const result = await handleSingleModel(body, modelStr);
      
      // Success (2xx) - return response
      if (result.ok) {
        log.info("COMBO", `Model ${modelStr} succeeded`);

        // Track NIM model health on success
        if (modelStr.startsWith("nvidia/")) {
          const nimModelId = modelStr.slice(7);
          const latencyHeader = result.headers.get("x-upstream-latency-ms");
          const latencyMs = latencyHeader ? Number(latencyHeader) : null;
          updateNimModelHealth(nimModelId, true, latencyMs).catch(() => {});
        }

        if (sessionKey) {
          // Evict oldest session lock if size limit is exceeded (LRU)
          if (sessionModelLocks.size >= MAX_SESSION_LOCKS && !sessionModelLocks.has(sessionKey)) {
            const oldestKey = sessionModelLocks.keys().next().value;
            if (oldestKey) {
              sessionModelLocks.delete(oldestKey);
            }
          }
          sessionModelLocks.set(sessionKey, {
            modelStr,
            lastAccessAt: Date.now()
          });
        }
        
        // Inject explanation header if available
        if (explanationMap && explanationMap[modelStr]) {
          const newHeaders = new Headers(result.headers);
          newHeaders.set("x-router-explanation", JSON.stringify(explanationMap[modelStr]));
          return new Response(result.body, {
            status: result.status,
            statusText: result.statusText,
            headers: newHeaders
          });
        }
        
        return result;
      }

      // Extract error info from response
      let errorText = result.statusText || "";
      let retryAfter = null;
      try {
        const errorBody = await result.clone().json();
        errorText = errorBody?.error?.message || errorBody?.error || errorBody?.message || errorText;
        retryAfter = errorBody?.retryAfter || null;
      } catch {
        // Ignore JSON parse errors
      }

      // Track earliest retryAfter across all combo models
      if (retryAfter && (!earliestRetryAfter || new Date(retryAfter) < new Date(earliestRetryAfter))) {
        earliestRetryAfter = retryAfter;
      }

      // Normalize error text to string (Worker-safe)
      if (typeof errorText !== "string") {
        try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
      }

      // Check if should fallback to next model
      const { shouldFallback, cooldownMs } = checkFallbackError(result.status, errorText);

      if (!shouldFallback) {
        log.warn("COMBO", `Model ${modelStr} failed (no fallback)`, { status: result.status });
        return result;
      }

      // For transient errors (503/502/504), wait for cooldown before falling through
      // so a briefly-overloaded provider gets a chance to recover rather than being
      // skipped immediately (fixes: combo falls through on transient 503)
      if (cooldownMs && cooldownMs > 0 && cooldownMs <= 5000 &&
          (result.status === 503 || result.status === 502 || result.status === 504)) {
        log.info("COMBO", `Model ${modelStr} transient ${result.status}, waiting ${cooldownMs}ms before next`);
        await new Promise(r => setTimeout(r, cooldownMs));
      }

      // Fallback to next model
      lastError = errorText || String(result.status);

      // Track NIM model health on failure
      if (modelStr.startsWith("nvidia/")) {
        const nimModelId = modelStr.slice(7);
        updateNimModelHealth(nimModelId, false, null).catch(() => {});
      }

      if (sessionKey && activeLockModel === modelStr) {
        sessionModelLocks.delete(sessionKey);
      }
      if (!lastStatus) lastStatus = result.status;
      log.warn("COMBO", `Model ${modelStr} failed, trying next`, { status: result.status });
    } catch (error) {
      // Catch unexpected exceptions to ensure fallback continues
      lastError = error.message || String(error);
      if (sessionKey && activeLockModel === modelStr) {
        sessionModelLocks.delete(sessionKey);
      }
      if (!lastStatus) lastStatus = 500;
      log.warn("COMBO", `Model ${modelStr} threw error, trying next`, { error: lastError });
    }
  }

  // All models failed
  // Use 503 (Service Unavailable) rather than 406 (Not Acceptable) — 406 implies
  // the request itself is invalid, but here the providers are simply unavailable
  // or have no active credentials. 503 is more accurate and retryable by clients.
  const allDisabled = lastError && lastError.toLowerCase().includes("no credentials");
  const status = allDisabled ? 503 : (lastStatus || 503);
  const msg = lastError || "All combo models unavailable";

  if (earliestRetryAfter) {
    const retryHuman = formatRetryAfter(earliestRetryAfter);
    log.warn("COMBO", `All models failed | ${msg} (${retryHuman})`);
    return unavailableResponse(status, msg, earliestRetryAfter, retryHuman);
  }

  log.warn("COMBO", `All models failed | ${msg}`);
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Dynamic promotion and demotion of github models between stable and experimental pools
 * @param {string} modelStr - The model string (e.g. "github/gpt-4.1")
 * @param {boolean} succeeded - Whether the request succeeded
 * @param {number|null} latencyMs - The latency of the request in ms
 */
export async function checkPromotionDemotion(modelStr, succeeded, latencyMs = null) {
  if (!modelStr || !modelStr.startsWith("github/")) return;

  try {
    const { getComboByName, updateCombo } = await import("@/lib/localDb");
    const { getAdapter } = await import("@/lib/db/driver.js");

    const stableCombo = await getComboByName("github-stable");
    const experimentalCombo = await getComboByName("github-experimental");

    if (!stableCombo || !experimentalCombo) return;

    const isStable = stableCombo.models.includes(modelStr);
    const isExperimental = experimentalCombo.models.includes(modelStr);

    if (!isStable && !isExperimental) return;

    // Parse provider and model names
    const parts = modelStr.split("/");
    const provider = parts[0];
    const model = parts[1];

    const db = await getAdapter();

    // Track latency window in memory
    if (succeeded && typeof latencyMs === "number") {
      let latencies = modelRecentLatencies.get(modelStr) || [];
      latencies.push(latencyMs);
      if (latencies.length > 50) latencies.shift();
      modelRecentLatencies.set(modelStr, latencies);
    }

    if (isExperimental && succeeded) {
      // Promotion check: 50 requests, success > 98% AND p95 latency < 10s
      // Fetch the last 50 requests for this model/provider
      const rows = db.all(
        `SELECT status FROM usageHistory WHERE provider = ? AND model = ? ORDER BY id DESC LIMIT 50`,
        [provider, model]
      );

      const latencies = modelRecentLatencies.get(modelStr) || [];

      if (rows.length === 50 && latencies.length === 50) {
        const successes = rows.filter(r => r.status === "ok").length;
        const successRate = successes / 50;

        const sorted = [...latencies].sort((a, b) => a - b);
        const p95Index = Math.floor(sorted.length * 0.95);
        const p95 = sorted[p95Index] || 0;

        if (successRate >= 0.98 && p95 < 10000) {
          // Promote: remove from experimental, add to stable
          const newExperimentalModels = experimentalCombo.models.filter(m => m !== modelStr);
          const newStableModels = [...stableCombo.models];
          if (!newStableModels.includes(modelStr)) {
            newStableModels.push(modelStr);
          }

          await updateCombo(experimentalCombo.id, { models: newExperimentalModels });
          await updateCombo(stableCombo.id, { models: newStableModels });
          console.log(`[COMBO] Model ${modelStr} promoted to stable pool (success rate: ${(successRate * 100).toFixed(1)}%, p95: ${(p95 / 1000).toFixed(2)}s)`);
        }
      }
    } else if (isStable && !succeeded) {
      // Demotion check: last 5 minutes error rate > 30% (min 5 requests)
      const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const rows = db.all(
        `SELECT status FROM usageHistory WHERE provider = ? AND model = ? AND timestamp >= ? ORDER BY id DESC`,
        [provider, model, cutoff]
      );

      if (rows.length >= 5) {
        const errors = rows.filter(r => r.status !== "ok").length;
        const errorRate = errors / rows.length;

        if (errorRate > 0.3) {
          // Demote: remove from stable, add to experimental
          const newStableModels = stableCombo.models.filter(m => m !== modelStr);
          const newExperimentalModels = [...experimentalCombo.models];
          if (!newExperimentalModels.includes(modelStr)) {
            newExperimentalModels.push(modelStr);
          }

          await updateCombo(stableCombo.id, { models: newStableModels });
          await updateCombo(experimentalCombo.id, { models: newExperimentalModels });
          console.log(`[COMBO] Model ${modelStr} demoted to experimental pool (error rate: ${(errorRate * 100).toFixed(1)}%)`);
        }
      }
    }
  } catch (error) {
    console.error("[COMBO] Error in checkPromotionDemotion:", error);
  }
}
