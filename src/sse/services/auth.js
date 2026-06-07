import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import * as log from "../utils/logger.js";

// Mutexes map to prevent race conditions during account selection per provider
const providerMutexes = new Map();

export const ConnectionHealth = {
  HEALTHY: "HEALTHY",
  RATE_LIMITED: "RATE_LIMITED",
  QUOTA_EXHAUSTED: "QUOTA_EXHAUSTED"
};

function getProviderMutex(providerId) {
  if (!providerMutexes.has(providerId)) {
    providerMutexes.set(providerId, Promise.resolve());
  }
  return providerMutexes.get(providerId);
}

/**
 * Fetch available models from GitHub Copilot API and cache them on the connection
 * @param {object} connection - Connection object
 * @returns {Promise<Array|null>} Discovered models or null on error
 */
export async function fetchAndStoreGithubModels(connection, integrator = "vscode-chat") {
  const token = connection.providerSpecificData?.copilotToken || connection.accessToken || connection.apiKey;
  if (!token) return null;

  try {
    const response = await fetch("https://api.githubcopilot.com/models", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "copilot-integration-id": integrator,
        "editor-version": "vscode/1.107.1",
        "editor-plugin-version": "copilot-chat/0.26.7",
        "user-agent": "GitHubCopilotChat/0.26.7",
        "Authorization": `Bearer ${token}`
      }
    });

    if (!response.ok) {
      console.error(`[AUTH] Failed to fetch GitHub models for connection ${connection.id} (${integrator}): ${response.status}`);
      return null;
    }

    const data = await response.json();
    if (!data?.data) return null;

    const models = data.data
      .filter(m => m.capabilities?.type === "chat")
      .filter(m => m.policy?.state !== "disabled")
      .map(m => {
        const endpoints = m.supported_endpoints || m.capabilities?.supported_endpoints || [];
        return {
          id: m.id,
          name: m.name || m.id,
          version: m.version,
          capabilityVersion: 1,
          endpoints: {
            chatCompletions: endpoints.includes("/chat/completions") || !endpoints.includes("/responses"),
            responses: endpoints.includes("/responses") || m.id.includes("codex") || m.id.includes("gpt-5.3")
          },
          features: {
            tools: !!(m.capabilities?.tools === true || m.capabilities?.limits?.tools === true),
            vision: !!(m.capabilities?.vision === true)
          },
          isDefault: m.model_picker_enabled === true
        };
      });

    const availableModelsByIntegrator = connection.availableModelsByIntegrator || {};
    availableModelsByIntegrator[integrator] = models;

    const lastModelDiscoveryAt = connection.lastModelDiscoveryAt && typeof connection.lastModelDiscoveryAt === "object"
      ? { ...connection.lastModelDiscoveryAt }
      : {};
    lastModelDiscoveryAt[integrator] = new Date().toISOString();

    await updateProviderConnection(connection.id, {
      availableModelsByIntegrator,
      lastModelDiscoveryAt
    });

    return models;
  } catch (error) {
    console.error(`[AUTH] Error fetching GitHub models for connection ${connection.id} (${integrator}):`, error);
    return null;
  }
}

/**
 * Extract integrator name from headers
 */
export function getIntegratorFromHeaders(headers) {
  if (!headers) return "vscode-chat";
  
  // Headers could be Headers object (Next.js) or a plain object
  const getHeader = (key) => {
    if (typeof headers.get === "function") return headers.get(key);
    const lowerKey = key.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lowerKey) return v;
    }
    return null;
  };

  const integrationId = getHeader("copilot-integration-id");
  if (integrationId) return integrationId;

  const ua = (getHeader("user-agent") || "").toLowerCase();
  if (ua.includes("cline")) return "cline";
  if (ua.includes("copilot-cli")) return "copilot-cli";
  if (ua.includes("copilot-agent") || ua.includes("copilotagent")) return "copilot-agent";

  return "vscode-chat";
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;

  // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
  const providerId = resolveProviderId(provider);

  // Acquire provider-specific mutex to prevent race conditions on priority-based rotation
  const providerMutex = getProviderMutex(providerId);
  const currentMutex = providerMutex;
  let resolveMutex;
  const nextMutex = new Promise(resolve => { resolveMutex = resolve; });
  providerMutexes.set(providerId, nextMutex);

  try {
    await currentMutex;

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: override.proxyPoolId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Filter out model-locked and excluded connections
    const availableConnections = [];
    for (const c of connections) {
      if (excludeSet.has(c.id)) continue;
      if (isModelLockActive(c, model)) continue;

      // For github provider, lazy-fetch availableModelsByIntegrator if empty or older than 24 hours
      if (providerId === "github") {
        const integrator = getIntegratorFromHeaders(options.headers);
        const availableModelsByIntegrator = c.availableModelsByIntegrator || {};
        const lastModelDiscoveryAt = c.lastModelDiscoveryAt || {};

        const modelsForIntegrator = availableModelsByIntegrator[integrator];
        const lastDiscovery = lastModelDiscoveryAt[integrator];
        const isExpired = !lastDiscovery || (Date.now() - new Date(lastDiscovery).getTime() > 24 * 60 * 60 * 1000);

        let availableModels = modelsForIntegrator;
        if (!availableModels || isExpired) {
          log.info("AUTH", `Lazy-fetching GitHub models for connection: ${c.displayName || c.id} (${integrator})`);
          const refreshedModels = await fetchAndStoreGithubModels(c, integrator);
          if (refreshedModels) {
            availableModels = refreshedModels;
          }
        }

        if (availableModels && model) {
          const cleanModel = model.startsWith("github/") ? model.slice(7) : model;
          const hasModel = availableModels.some(m => m.id === cleanModel || m.id === model);
          if (!hasModel) {
            log.debug("AUTH", `Connection ${c.id?.slice(0, 8)} does not support model ${model} for integrator ${integrator}`);
            continue;
          }
        }
      }

      availableConnections.push(c);
    }

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // Find earliest lock expiry across all connections for retry timing
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }
    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      availableModels: connection.availableModels || null,
      availableModelsByIntegrator: connection.availableModelsByIntegrator || null,
      modelHealth: connection.modelHealth || null,
      connectionHealth: connection.connectionHealth || ConnectionHealth.HEALTHY,
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      _connection: connection
    };  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export const providerFailures = new Map(); // providerId -> count
export const providerCooldowns = new Map(); // providerId -> timestamp (cooldown expiration)

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    cooldownMs = Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 100) : "Provider error";

  // Handle model health scoring and auto-disable
  let modelHealth = conn?.modelHealth || {};
  let cooldownForLock = cooldownMs;
  let lockModel = model;
  let connectionHealth = conn?.connectionHealth || ConnectionHealth.HEALTHY;

  const lowerError = reason.toLowerCase();
  const isQuota = lowerError.includes("quota") || 
                  lowerError.includes("credit") || 
                  lowerError.includes("billing") || 
                  status === 403;

  if (isQuota) {
    // Lock the entire connection (account-level lock) for 24 hours
    cooldownForLock = 24 * 60 * 60 * 1000;
    lockModel = null;
    connectionHealth = ConnectionHealth.QUOTA_EXHAUSTED;
    log.warn("AUTH", `Locking connection ${connectionId} for 24 hours due to quota exhaustion: ${reason}`);
  } else if (model) {
    const isFatal = lowerError.includes("model_not_supported") || 
                    lowerError.includes("model_not_available_for_integrator") ||
                    lowerError.includes("model_not_found") ||
                    lowerError.includes("not accessible via the /chat/completions endpoint");

    const modelRecord = modelHealth[model] || { failCount: 0 };
    modelRecord.failCount = (modelRecord.failCount || 0) + 1;
    modelRecord.lastError = reason;
    modelRecord.lastErrorAt = new Date().toISOString();

    if (isFatal) {
      // Disable for 24 hours (Fatal error)
      cooldownForLock = 24 * 60 * 60 * 1000;
      modelRecord.disabledUntil = new Date(Date.now() + cooldownForLock).toISOString();
      modelRecord.status = "fatal_error";
      log.warn("AUTH", `Auto-disabling model ${model} for 24 hours due to fatal error: ${reason}`);
    } else if (modelRecord.failCount >= 3) {
      // Disable for 15 minutes (Transient repeated failures)
      cooldownForLock = 15 * 60 * 1000;
      modelRecord.disabledUntil = new Date(Date.now() + cooldownForLock).toISOString();
      modelRecord.status = "transient_error";
      log.warn("AUTH", `Auto-disabling model ${model} for 15 minutes due to transient or repeated failures: ${reason}`);
    } else {
      modelRecord.status = "active";
    }
    modelHealth[model] = modelRecord;

    // Provider-wide outage tracking for transient failures
    if (provider && !isFatal) {
      const currentFailures = (providerFailures.get(provider) || 0) + 1;
      providerFailures.set(provider, currentFailures);
      if (currentFailures >= 5) {
        const cooldownUntil = Date.now() + 5 * 60 * 1000;
        providerCooldowns.set(provider, cooldownUntil);
        log.warn("AUTH", `Provider ${provider} triggered outage cooldown (5 consecutive failures). Cooling down for 5 minutes.`);
      }
    }
  }

  if (!isQuota && (status === 429 || resetsAtMs || (model && modelHealth[model]?.status === "transient_error"))) {
    connectionHealth = ConnectionHealth.RATE_LIMITED;
  }

  const lockUpdate = buildModelLockUpdate(lockModel, cooldownForLock);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    modelHealth,
    connectionHealth,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Clear provider-level failures/cooldown on successful request
  if (conn.provider) {
    providerFailures.set(conn.provider, 0);
    providerCooldowns.delete(conn.provider);
  }

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, { testStatus: "active", lastError: null, lastErrorAt: null, backoffLevel: 0, connectionHealth: ConnectionHealth.HEALTHY });
  } else {
    if (keysToClear.includes("modelLock___all")) {
      clearObj.connectionHealth = remainingActiveLocks.length > 0 ? ConnectionHealth.RATE_LIMITED : ConnectionHealth.HEALTHY;
    }
  }

  // Reset modelHealth failCount for successful model
  if (model && conn.modelHealth && conn.modelHealth[model]) {
    const updatedHealth = { ...conn.modelHealth };
    updatedHealth[model] = {
      ...updatedHealth[model],
      failCount: 0,
      disabledUntil: null
    };
    clearObj.modelHealth = updatedHealth;
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
