/**
 * NVIDIA NIM Model Discovery Service
 *
 * Phase 1-8: Auto-discovers models from NVIDIA NIM catalog, categorizes them
 * by family/keyword/features, scores them into tiers, and auto-seeds combos.
 *
 * Runs on:
 *   - Provider login (triggered from auth flow)
 *   - Daily cron (12h interval via server startup or manual trigger)
 *   - Manual refresh (admin UI / API)
 */

import { getAdapter } from "@/lib/db/driver.js";

// ─── Constants ───────────────────────────────────────────────────────────

const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";

/** How often to auto-refresh (ms) — 12 hours */
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Regex-based keyword → category mapping. Order matters: earlier match wins. */
const CATEGORY_PATTERNS = [
  [/coder|code|deepseek/i, "coding"],
  [/reason|ultra|kimi|opus/i, "reasoning"],
  [/flash|nano|mini|tiny|lite/i, "fast"],
  [/agent|nemotron.*(?:super|ultra)/i, "agent"],
  [/vision|vl|multimodal/i, "vision"],
  [/embed|nv-embed/i, "embedding"],
];

/** Family extraction from model_id */
const FAMILY_PATTERNS = [
  { pattern: /deepseek/i, family: "deepseek" },
  { pattern: /qwen/i, family: "qwen" },
  { pattern: /kimi/i, family: "kimi" },
  { pattern: /nemotron/i, family: "nemotron" },
  { pattern: /minimax/i, family: "minimax" },
  { pattern: /glm/i, family: "glm" },
  { pattern: /gemma/i, family: "gemma" },
  { pattern: /llama/i, family: "llama" },
  { pattern: /mistral/i, family: "mistral" },
  { pattern: /phi/i, family: "phi" },
  { pattern: /command.?r/i, family: "command-r" },
  { pattern: /nv-embed|embedqa|nemotron-embed/i, family: "embedding" },
];

/** Tier ranking — model_id substring match, earlier match = higher tier */
const TIER_PATTERNS = [
  [/deepseek.*v4.*pro|qwen3.*coder.*480/i, "A"],
  [/deepseek.*v4.*flash|kimi.*k2\.[5-9]|nemotron.*super/i, "B"],
  [/minimax.*m[23]|nemotron.*ultra|qwen3.*max/i, "B"],
  [/glm.*[45]|gemma|llama.*3\.[23]/i, "C"],
  [/mistral|phi/i, "D"],
];

/** Known NIM models (fallback when /v1/models API unavailable) */
const KNOWN_NIM_MODELS = [
  { model_id: "deepseek-ai/deepseek-v4-pro", family: "deepseek", display_name: "DeepSeek V4 Pro", tier: "A" },
  { model_id: "deepseek-ai/deepseek-v4-flash", family: "deepseek", display_name: "DeepSeek V4 Flash", tier: "B" },
  { model_id: "qwen/qwen3-coder-480b-a35b-instruct", family: "qwen", display_name: "Qwen3 Coder 480B", tier: "A" },
  { model_id: "qwen/qwen3-235b-a22b-instruct-2507", family: "qwen", display_name: "Qwen3 235B A22B", tier: "C" },
  { model_id: "moonshotai/kimi-k2.6", family: "kimi", display_name: "Kimi K2.6", tier: "B" },
  { model_id: "nvidia/nemotron-3-super-49b", family: "nemotron", display_name: "Nemotron 3 Super 49B", tier: "B" },
  { model_id: "nvidia/nemotron-3-ultra", family: "nemotron", display_name: "Nemotron 3 Ultra", tier: "B" },
  { model_id: "nvidia/nemotron-3-nano-8b", family: "nemotron", display_name: "Nemotron 3 Nano 8B", tier: "C" },
  { model_id: "minimaxai/minimax-m2.7", family: "minimax", display_name: "MiniMax M2.7", tier: "B" },
  { model_id: "z-ai/glm-5.1", family: "glm", display_name: "GLM 5.1", tier: "C" },
  { model_id: "z-ai/glm-4.7", family: "glm", display_name: "GLM 4.7", tier: "D" },
  { model_id: "google/gemma-4-31b-it", family: "gemma", display_name: "Gemma 4 31B IT", tier: "D" },
  { model_id: "meta/llama-3.3-70b-instruct", family: "llama", display_name: "Llama 3.3 70B", tier: "D" },
  { model_id: "mistralai/mistral-large-3", family: "mistral", display_name: "Mistral Large 3", tier: "D" },
  { model_id: "nvidia/nv-embedqa-e5-v5", family: "embedding", display_name: "NV EmbedQA E5 v5", tier: "C" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────

function categorize(modelId, capabilities = {}) {
  const lower = (modelId || "").toLowerCase();
  const hasTools = capabilities.tools || capabilities.supports_tools;
  const hasReasoning = capabilities.reasoning || capabilities.supports_reasoning;
  // Agentic: tools + reasoning → highest priority
  if (hasTools && hasReasoning) return "agent";
  for (const [pattern, category] of CATEGORY_PATTERNS) {
    if (pattern.test(lower)) return category;
  }
  return "general";
}

function extractFamily(modelId) {
  for (const { pattern, family } of FAMILY_PATTERNS) {
    if (pattern.test(modelId)) return family;
  }
  return "other";
}

function computeTier(modelId, family) {
  for (const [pattern, tier] of TIER_PATTERNS) {
    if (pattern.test(modelId)) return tier;
  }
  const familyTiers = {
    deepseek: "B", qwen: "B", kimi: "B", nemotron: "B",
    minimax: "C", glm: "D", gemma: "D", llama: "D",
    mistral: "D", phi: "D", embedding: "C",
  };
  return familyTiers[family] || "D";
}

function parseCapabilities(model) {
  if (!model) return {};
  const caps = (model && model.capabilities) ? model.capabilities : {};
  if (typeof caps !== "object" || Array.isArray(caps)) return {};
  return {
    tools: !!(caps.tools || caps.supports_tools),
    vision: !!(caps.vision || caps.supports_vision),
    reasoning: !!(caps.reasoning || caps.supports_reasoning),
    long_context: !!(caps.long_context || caps.supports_long_context || (caps.max_context && caps.max_context >= 128000)),
    max_context: caps.max_context || caps.context_window || caps.context_length || null,
  };
}

// ─── Discovery ────────────────────────────────────────────────────────────

/**
 * Fetch available models from NVIDIA NIM /v1/models endpoint.
 */
export async function fetchNimModels(apiKey) {
  if (!apiKey) return null;
  try {
    const response = await fetch(`${NIM_BASE_URL}/models`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!response.ok) {
      console.error(`[NIM] /v1/models failed: ${response.status}`);
      return null;
    }
    const data = await response.json();
    const models = data?.data || data?.models || data || [];
    return Array.isArray(models) ? models : [];
  } catch (error) {
    console.error(`[NIM] fetchNimModels error:`, error.message);
    return null;
  }
}

/**
 * Sync discovered models into provider_models table.
 * Merges API-discovered + known fallback → DB.
 */
export async function syncNimModelsToDb(apiKey = null) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  let entries = [];

  // 1. Live API fetch
  if (apiKey) {
    const rawModels = await fetchNimModels(apiKey);
    if (rawModels && rawModels.length > 0) {
      entries = rawModels.map((m) => {
        const modelId = m.id || m.model || m.name;
        const family = extractFamily(modelId);
        const caps = parseCapabilities(m);
        return {
          model_id: modelId,
          family,
          display_name: m.name || m.display_name || modelId,
          category: categorize(modelId, caps),
          tier: computeTier(modelId, family),
          supports_tools: caps.tools ? 1 : 0,
          supports_vision: caps.vision ? 1 : 0,
          supports_reasoning: caps.reasoning ? 1 : 0,
          supports_long_context: caps.long_context ? 1 : 0,
          max_context: caps.max_context || null,
          capabilities: JSON.stringify(caps),
        };
      });
    }
  }

  // 2. Merge known fallback models
  const seen = new Set(entries.map((e) => e.model_id));
  for (const known of KNOWN_NIM_MODELS) {
    if (seen.has(known.model_id)) continue;
    const caps = parseCapabilities(known);
    entries.push({
      model_id: known.model_id,
      family: known.family,
      display_name: known.display_name,
      category: categorize(known.model_id, caps),
      tier: known.tier || computeTier(known.model_id, known.family),
      supports_tools: caps.tools ? 1 : 0,
      supports_vision: caps.vision ? 1 : 0,
      supports_reasoning: caps.reasoning ? 1 : 0,
      supports_long_context: caps.long_context ? 1 : 0,
      max_context: caps.max_context || null,
      capabilities: JSON.stringify(caps),
    });
  }

  // 3. Upsert
  let added = 0;
  let updated = 0;

  db.transaction(() => {
    for (const m of entries) {
      const existing = db.get(
        "SELECT id, status, health_score, tier, category FROM provider_models WHERE provider = ? AND model_id = ?",
        ["nvidia", m.model_id],
      );

      if (existing) {
        db.run(
          `UPDATE provider_models SET
            family = ?, display_name = ?, category = ?, tier = ?,
            supports_tools = ?, supports_vision = ?, supports_reasoning = ?,
            supports_long_context = ?, max_context = ?, capabilities = ?,
            updated_at = ?
           WHERE provider = ? AND model_id = ?`,
          [
            m.family, m.display_name, m.category, m.tier,
            m.supports_tools, m.supports_vision, m.supports_reasoning,
            m.supports_long_context, m.max_context, m.capabilities, now,
            "nvidia", m.model_id,
          ],
        );
        updated++;
      } else {
        const id = `nvidia-${m.model_id.replace(/[/:]/g, "-")}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        db.run(
          `INSERT INTO provider_models
           (id, provider, model_id, family, display_name, category, tier,
            supports_tools, supports_vision, supports_reasoning,
            supports_long_context, max_context, capabilities, status,
            discovered_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          [
            id, "nvidia", m.model_id, m.family, m.display_name, m.category, m.tier,
            m.supports_tools, m.supports_vision, m.supports_reasoning,
            m.supports_long_context, m.max_context, m.capabilities, now, now,
          ],
        );
        added++;
      }
    }
  });

  console.log(`[NIM] Sync complete: +${added} added, ~${updated} updated, ${entries.length} total`);
  return { added, updated, total: entries.length };
}

// ─── Health Scoring ───────────────────────────────────────────────────────

/**
 * Update health score for a NIM model after a request completes.
 */
export async function updateNimModelHealth(modelId, succeeded, latencyMs = null) {
  const db = await getAdapter();

  const model = db.get(
    "SELECT * FROM provider_models WHERE provider = ? AND model_id = ?",
    ["nvidia", modelId],
  );
  if (!model) return;

  const newSuccess = (model.success_count || 0) + (succeeded ? 1 : 0);
  const newFail = (model.fail_count || 0) + (succeeded ? 0 : 1);
  const total = newSuccess + newFail;

  let newAvgLatency = model.avg_latency_ms;
  if (latencyMs && latencyMs > 0) {
    const alpha = 0.2;
    newAvgLatency = model.avg_latency_ms
      ? model.avg_latency_ms * (1 - alpha) + latencyMs * alpha
      : latencyMs;
  }

  const successRate = total > 0 ? newSuccess / total : 1.0;
  const latencyFactor = newAvgLatency
    ? Math.max(0, 1.0 - (newAvgLatency / 10000))
    : 1.0;
  const healthScore = Math.round((successRate * 0.6 + latencyFactor * 0.4) * 100) / 100;
  const newStatus = healthScore < 0.3 ? "degraded" : "active";
  const now = new Date().toISOString();

  db.run(
    `UPDATE provider_models SET
      health_score = ?, success_count = ?, fail_count = ?,
      avg_latency_ms = ?, status = ?, updated_at = ?
     WHERE provider = ? AND model_id = ?`,
    [healthScore, newSuccess, newFail, Math.round(newAvgLatency || 0), newStatus, now, "nvidia", modelId],
  );
}

// ─── Auto-Seeding ─────────────────────────────────────────────────────────

const NIM_COMBO_TEMPLATES = [
  { name: "nim-coding", category: "coding", strategy: "score" },
  { name: "nim-reasoning", category: "reasoning", strategy: "score" },
  { name: "nim-fast", category: "fast", strategy: "score" },
  { name: "nim-agent", category: "agent", strategy: "score" },
  { name: "nim-general", category: "general", strategy: "score" },
  { name: "nim-survival", category: null, strategy: "fallback" },
];

/**
 * Auto-seed NIM combos from provider_models data.
 */
export async function seedNimCombos() {
  const db = await getAdapter();
  const now = new Date().toISOString();
  let seeded = 0;
  let updated = 0;

  for (const template of NIM_COMBO_TEMPLATES) {
    let models;
    if (template.name === "nim-survival") {
      models = db
        .all(
          `SELECT model_id FROM provider_models
           WHERE provider = 'nvidia' AND status = 'active' AND category != 'embedding'
           ORDER BY tier DESC, health_score DESC`,
        )
        .map((r) => `nvidia/${r.model_id}`);
    } else {
      models = db
        .all(
          `SELECT model_id FROM provider_models
           WHERE provider = 'nvidia' AND status = 'active' AND category = ?
           ORDER BY tier ASC, health_score DESC
           LIMIT 5`,
          [template.category],
        )
        .map((r) => `nvidia/${r.model_id}`);
    }

    if (models.length === 0) {
      console.log(`[NIM] Skipping combo ${template.name}: no models for category=${template.category}`);
      continue;
    }

    const existing = db.get("SELECT id, models FROM combos WHERE name = ?", [template.name]);

    if (existing) {
      db.run("UPDATE combos SET models = ?, updatedAt = ? WHERE name = ?", [
        JSON.stringify(models), now, template.name,
      ]);
      updated++;
    } else {
      const id = `combo-${template.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      db.run(
        "INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)",
        [id, template.name, null, JSON.stringify(models), now, now],
      );
      seeded++;
    }
  }

  console.log(`[NIM] Combo seeding: +${seeded} new, ~${updated} updated`);
  return { seeded, updated };
}

// ─── Orchestration ────────────────────────────────────────────────────────

let lastSyncAt = 0;

/**
 * Main entry: discover → categorize → score → seed combos.
 */
export async function runNimDiscovery(apiKey = null) {
  const now = Date.now();
  if (now - lastSyncAt < 30000) {
    console.log("[NIM] Skipping sync: last run <30s ago");
    return { skipped: true };
  }
  lastSyncAt = now;

  console.log("[NIM] Starting discovery cycle...");
  const syncResult = await syncNimModelsToDb(apiKey);
  const seedResult = await seedNimCombos();

  return { sync: syncResult, seed: seedResult };
}

/**
 * Check if 12h refresh is due and run if so.
 */
export async function autoRefreshIfDue(apiKey = null) {
  const db = await getAdapter();
  try {
    const row = db.get("SELECT value FROM _meta WHERE key = ?", ["lastNimSyncAt"]);
    const lastSync = row ? new Date(row.value).getTime() : 0;
    if (Date.now() - lastSync > REFRESH_INTERVAL_MS) {
      const result = await runNimDiscovery(apiKey);
      db.run("INSERT OR REPLACE INTO _meta(key, value) VALUES(?, ?)", [
        "lastNimSyncAt", new Date().toISOString(),
      ]);
      return result;
    }
  } catch {
    const result = await runNimDiscovery(apiKey);
    try {
      db.run("INSERT OR REPLACE INTO _meta(key, value) VALUES(?, ?)", [
        "lastNimSyncAt", new Date().toISOString(),
      ]);
    } catch { /* _meta may not exist */ }
    return result;
  }
  return { skipped: true, reason: "not due" };
}

/**
 * Query provider_models by category (used by router for dynamic combos).
 */
export async function getNimModelsByCategory(category, { minTier = "D", activeOnly = true } = {}) {
  const db = await getAdapter();
  const tierOrder = { A: 1, B: 2, C: 3, D: 4 };
  const tierRank = Object.entries(tierOrder)
    .map(([t, n]) => `WHEN '${t}' THEN ${n}`)
    .join(" ");

  let sql = "SELECT * FROM provider_models WHERE provider = 'nvidia'";
  const params = [];
  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }
  if (activeOnly) sql += " AND status = 'active'";
  sql += ` ORDER BY CASE tier ${tierRank} END ASC, health_score DESC`;

  return db.all(sql, params).filter((m) => {
    const val = tierOrder[m.tier] || 99;
    return val <= (tierOrder[minTier] || 99);
  });
}

/**
 * Get all NIM models for admin UI.
 */
export async function getAllNimModels() {
  const db = await getAdapter();
  return db.all("SELECT * FROM provider_models WHERE provider = 'nvidia' ORDER BY tier ASC, health_score DESC");
}