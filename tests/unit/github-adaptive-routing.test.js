import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { classifyTask, getCapabilityScore, sessionModelLocks, handleComboChat } from "../../open-sse/services/combo.js";
import { getIntegratorFromHeaders, markAccountUnavailable, clearAccountError, providerFailures, providerCooldowns, ConnectionHealth } from "../../src/sse/services/auth.js";

describe("GitHub Adaptive Routing - Task Classification", () => {
  it("classifies task based on model string suffix/name", () => {
    expect(classifyTask("github/auto-fast", {})).toBe("fast");
    expect(classifyTask("gh/auto-coding", {})).toBe("coding");
    expect(classifyTask("github/auto-agent", {})).toBe("agent");
    expect(classifyTask("gh/auto-reasoning", {})).toBe("reasoning");
    expect(classifyTask("github/auto", {})).toBe("general");
    expect(classifyTask("gh/auto-canary", {})).toBe("general");
  });

  it("classifies task based on request body properties", () => {
    // If tools are present, classify as agent
    expect(classifyTask("gh/auto", { tools: [{ type: "function" }] })).toBe("agent");

    // If reasoning effort is present, classify as reasoning
    expect(classifyTask("gh/auto", { reasoning_effort: "medium" })).toBe("reasoning");
    expect(classifyTask("gh/auto", { reasoning: { effort: "high" } })).toBe("reasoning");
  });

  it("defaults to general if no specific indicator is found", () => {
    expect(classifyTask("gh/auto", {})).toBe("general");
    expect(classifyTask("", {})).toBe("general");
    expect(classifyTask(null, {})).toBe("general");
  });
});

describe("GitHub Adaptive Routing - Capability Scoring", () => {
  it("returns correct suitability scores for specific models", () => {
    // Coding task
    expect(getCapabilityScore("coding", "github/claude-sonnet-4.6")).toBe(1.0);
    expect(getCapabilityScore("coding", "github/gpt-4o")).toBe(0.9);
    expect(getCapabilityScore("coding", "github/claude-haiku-4.5")).toBe(0.6);

    // Fast task
    expect(getCapabilityScore("fast", "github/gpt-5-mini")).toBe(1.0);
    expect(getCapabilityScore("fast", "github/gpt-4o-mini")).toBe(0.9);
    expect(getCapabilityScore("fast", "github/gpt-4o")).toBe(0.6);

    // Agent task
    expect(getCapabilityScore("agent", "github/gpt-5.3-codex")).toBe(1.0);
    expect(getCapabilityScore("agent", "github/claude-sonnet-4.6")).toBe(0.9);

    // Reasoning task
    expect(getCapabilityScore("reasoning", "github/claude-opus-4.8")).toBe(1.0);
    expect(getCapabilityScore("reasoning", "github/gpt-5.5")).toBe(0.95);
  });

  it("returns fallback score for unknown models", () => {
    expect(getCapabilityScore("coding", "github/unknown-model")).toBe(0.5);
    expect(getCapabilityScore("general", "github/unknown-model")).toBe(0.5);
  });
});

describe("GitHub Adaptive Routing - Integrator Extraction", () => {
  it("extracts integrator from headers correctly", () => {
    expect(getIntegratorFromHeaders(null)).toBe("vscode-chat");
    
    // Headers object
    const headersObj = new Headers();
    headersObj.set("copilot-integration-id", "custom-copilot");
    expect(getIntegratorFromHeaders(headersObj)).toBe("custom-copilot");

    // Plain object
    expect(getIntegratorFromHeaders({ "copilot-integration-id": "my-client" })).toBe("my-client");
    expect(getIntegratorFromHeaders({ "Copilot-Integration-Id": "my-client-caps" })).toBe("my-client-caps");

    // User agent fallbacks
    expect(getIntegratorFromHeaders({ "user-agent": "Cline/1.0" })).toBe("cline");
    expect(getIntegratorFromHeaders({ "user-agent": "copilot-cli/1.2" })).toBe("copilot-cli");
    expect(getIntegratorFromHeaders({ "user-agent": "GitHubCopilotAgent/0.26" })).toBe("copilot-agent");
  });
});

describe("GitHub Adaptive Routing - Connection Health and Lockouts", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let sqliteDb;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-db-routing-test-"));
    process.env.DATA_DIR = tempDir;
    sqliteDb = await import("@/lib/db/index.js");
    await sqliteDb.initDb();
  });

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("locks entire connection and sets QUOTA_EXHAUSTED on quota errors", async () => {
    const connName = `quota-test-${Math.random()}`;
    const conn = await sqliteDb.createProviderConnection({
      provider: "github",
      authType: "apikey",
      name: connName,
      apiKey: "gh-token-1"
    });

    try {
      // Simulate quota error (status 403 / body containing quota)
      await markAccountUnavailable(conn.id, 403, "rate_limit_exceeded (quota exhausted)", "github", "gpt-4o");

      const updated = await sqliteDb.getProviderConnectionById(conn.id);
      expect(updated.connectionHealth).toBe(ConnectionHealth.QUOTA_EXHAUSTED);
      expect(updated.modelLock___all).toBeDefined();
      // specific model lock should not be set (or should fall back to all)
      expect(updated.modelLock_gpt_4o).toBeUndefined();

      // Succeeded request clears error state
      await clearAccountError(conn.id, updated, "gpt-4o");
      const cleared = await sqliteDb.getProviderConnectionById(conn.id);
      expect(cleared.connectionHealth).toBe(ConnectionHealth.HEALTHY);
      expect(cleared.modelLock___all).toBeNull();
    } finally {
      await sqliteDb.deleteProviderConnection(conn.id);
    }
  });

  it("locks specific model and sets RATE_LIMITED on transient errors after 3 failures", async () => {
    const connName = `transient-test-${Math.random()}`;
    const conn = await sqliteDb.createProviderConnection({
      provider: "github",
      authType: "apikey",
      name: connName,
      apiKey: "gh-token-2"
    });

    try {
      // 1st failure
      await markAccountUnavailable(conn.id, 503, "Service Unavailable", "github", "gpt-4o");
      let updated = await sqliteDb.getProviderConnectionById(conn.id);
      expect(updated.modelHealth?.["gpt-4o"]?.failCount).toBe(1);
      expect(updated.modelHealth?.["gpt-4o"]?.status).toBe("active");
      expect(updated.connectionHealth).toBe(ConnectionHealth.HEALTHY); // not rate limited yet

      // 2nd failure
      await markAccountUnavailable(conn.id, 503, "Service Unavailable", "github", "gpt-4o");
      updated = await sqliteDb.getProviderConnectionById(conn.id);
      expect(updated.modelHealth?.["gpt-4o"]?.failCount).toBe(2);

      // 3rd failure (triggers transient disablement)
      await markAccountUnavailable(conn.id, 503, "Service Unavailable", "github", "gpt-4o");
      updated = await sqliteDb.getProviderConnectionById(conn.id);
      expect(updated.modelHealth?.["gpt-4o"]?.failCount).toBe(3);
      expect(updated.modelHealth?.["gpt-4o"]?.status).toBe("transient_error");
      expect(updated.connectionHealth).toBe(ConnectionHealth.RATE_LIMITED);
      expect(updated["modelLock_gpt-4o"]).toBeDefined();
      expect(updated.modelLock___all).toBeUndefined();

      // Succeeded request resets fail count and health status
      await clearAccountError(conn.id, updated, "gpt-4o");
      const cleared = await sqliteDb.getProviderConnectionById(conn.id);
      expect(cleared.connectionHealth).toBe(ConnectionHealth.HEALTHY);
      expect(cleared["modelLock_gpt-4o"]).toBeNull();
      expect(cleared.modelHealth?.["gpt-4o"]?.failCount).toBe(0);
    } finally {
      await sqliteDb.deleteProviderConnection(conn.id);
    }
  });
});

describe("GitHub Adaptive Routing - Session Lock LRU Eviction", () => {
  it("evicts the oldest session lock when exceeding MAX_SESSION_LOCKS = 5000", async () => {
    sessionModelLocks.clear();
    const dummyHandle = async () => new Response("ok", { status: 200 });
    const logMock = { info: () => {}, warn: () => {} };

    // Set 5000 locks first
    for (let i = 0; i < 5000; i++) {
      sessionModelLocks.set(`session-${i}:general`, {
        modelStr: "github/gpt-4o",
        lastAccessAt: Date.now()
      });
    }

    expect(sessionModelLocks.size).toBe(5000);
    expect(sessionModelLocks.has("session-0:general")).toBe(true);

    // Call handleComboChat with the 5001st session key which triggers eviction
    await handleComboChat({
      body: { conversation_id: "session-5000" },
      models: ["github/gpt-4o"],
      handleSingleModel: dummyHandle,
      log: logMock,
      comboName: "github-stable",
      comboStrategy: "fallback"
    });

    expect(sessionModelLocks.size).toBe(5000);
    expect(sessionModelLocks.has("session-0:general")).toBe(false); // Evicted!
    expect(sessionModelLocks.has("session-1:general")).toBe(true);
    expect(sessionModelLocks.has("session-5000:general")).toBe(true);
  });
});

describe("GitHub Adaptive Routing - Provider Health Outage Cooldown", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let sqliteDb;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-db-provider-health-test-"));
    process.env.DATA_DIR = tempDir;
    sqliteDb = await import("@/lib/db/index.js");
    await sqliteDb.initDb();
  });

  afterAll(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("cooldowns the provider after 5 consecutive failures and resets on success", async () => {
    providerFailures.clear();
    providerCooldowns.clear();

    const connName = `provider-health-${Math.random()}`;
    const conn = await sqliteDb.createProviderConnection({
      provider: "test-provider",
      authType: "apikey",
      name: connName,
      apiKey: "test-token"
    });

    try {
      // 4 failures
      for (let i = 0; i < 4; i++) {
        await markAccountUnavailable(conn.id, 503, "Service Unavailable", "test-provider", "test-model");
      }
      expect(providerFailures.get("test-provider")).toBe(4);
      expect(providerCooldowns.has("test-provider")).toBe(false);

      // 5th failure triggers provider-wide cooldown
      await markAccountUnavailable(conn.id, 503, "Service Unavailable", "test-provider", "test-model");
      expect(providerFailures.get("test-provider")).toBe(5);
      expect(providerCooldowns.has("test-provider")).toBe(true);

      // Succeeded request resets failures and cooldown
      const updated = await sqliteDb.getProviderConnectionById(conn.id);
      await clearAccountError(conn.id, updated, "test-model");
      expect(providerFailures.get("test-provider")).toBe(0);
      expect(providerCooldowns.has("test-provider")).toBe(false);
    } finally {
      await sqliteDb.deleteProviderConnection(conn.id);
    }
  });
});
