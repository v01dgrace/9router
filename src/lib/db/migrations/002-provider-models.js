// Add provider_models table for dynamic NVIDIA NIM model registry.
// Enables auto-discovery, capability tracking, categorization, and health scoring.

export default {
  version: 2,
  name: "provider-models",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_models (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        family TEXT,
        display_name TEXT,
        category TEXT,
        tier TEXT DEFAULT 'C',
        supports_tools INTEGER DEFAULT 0,
        supports_vision INTEGER DEFAULT 0,
        supports_reasoning INTEGER DEFAULT 0,
        supports_long_context INTEGER DEFAULT 0,
        max_context INTEGER,
        capabilities TEXT,
        status TEXT DEFAULT 'active',
        health_score REAL DEFAULT 1.0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        avg_latency_ms REAL,
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_pm_provider ON provider_models(provider)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pm_category ON provider_models(category)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pm_tier ON provider_models(tier)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pm_status ON provider_models(status)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_provider_model ON provider_models(provider, model_id)`);
  },
};