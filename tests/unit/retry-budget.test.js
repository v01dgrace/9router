import { vi } from "vitest";

vi.hoisted(() => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-db-retry-budget-test-"));
  process.env.DATA_DIR = tempDir;
  process.env.TEMP_DATA_DIR = tempDir;
});

import fs from "node:fs";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { handleComboChat, sortModelsByScore, filterUnhealthyCandidates } from "../../open-sse/services/combo.js";
import { markAccountUnavailable, clearAccountError, providerCooldowns, providerTimeoutFailures, ConnectionHealth } from "../../src/sse/services/auth.js";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import * as sqliteDb from "../../src/lib/db/index.js";

// Mock proxyAwareFetch to isolate tests from network and TLS dispatchers
let mockProxyAwareFetch = vi.fn();

vi.mock("../../open-sse/utils/proxyFetch.js", () => {
  return {
    proxyAwareFetch: (url, options) => mockProxyAwareFetch(url, options)
  };
});

describe("Retry Budget & Scoped Circuit Breakers", () => {
  const originalDataDir = process.env.DATA_DIR;

  beforeAll(async () => {
    await sqliteDb.initDb();
  });

  afterAll(() => {
    const tempDir = process.env.TEMP_DATA_DIR;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProxyAwareFetch.mockReset();
    providerCooldowns.clear();
    providerTimeoutFailures.clear();
    
    // Clear the database connections to avoid test pollution (safely inside temp database)
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    await db.run("DELETE FROM providerConnections");
  });

  // Test 1 — NVIDIA provider hard skip
  it("Test 1 — NVIDIA provider hard skip: sortModelsByScore excludes nvidia candidates when ratio >= 0.8", async () => {
    // Create 32 active rate-limited NVIDIA connections in DB
    const conns = [];
    for (let i = 0; i < 32; i++) {
      const conn = await sqliteDb.createProviderConnection({
        provider: "nvidia",
        authType: "apikey",
        name: `nvidia-hard-skip-${i}-${Math.random()}`,
        apiKey: `nv-token-${i}`
      });
      await sqliteDb.updateProviderConnection(conn.id, {
        connectionHealth: ConnectionHealth.RATE_LIMITED
      });
      conns.push(conn);
    }

    try {
      // sortModelsByScore should exclude nvidia candidates since 32/32 = 1.0 (>= 0.8)
      const result = await sortModelsByScore(["nvidia/deepseek-ai/deepseek-v4-pro"]);
      expect(result.sortedModels).not.toContain("nvidia/deepseek-ai/deepseek-v4-pro");
    } finally {
      for (const conn of conns) {
        await sqliteDb.deleteProviderConnection(conn.id);
      }
    }
  });

  // Test 2 — BaseExecutor không retry timeout trong combo
  it("Test 2 — BaseExecutor không retry timeout trong combo: BaseExecutor execute tries exactly once", async () => {
    class MockExecutor extends BaseExecutor {
      constructor() {
        super();
        this.provider = "test-provider";
        this.config = { urls: ["https://api.test/v1"] };
      }
      getFallbackCount() { return 1; }
      buildUrl() { return "https://api.test/v1"; }
      transformRequest(model, body) { return body; }
      buildHeaders() { return {}; }
    }

    const executor = new MockExecutor();
    
    // Mock proxyAwareFetch to return 502 Bad Gateway
    mockProxyAwareFetch.mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ error: "timeout" }), { status: 502 })
    ));

    const retryBudget = {
      isComboPath: true,
      maxExecutorRetries: 0,
      disableExecutorRetryFor: ["HTTP_502"],
      maxTotalAttempts: 4,
      totalAttempts: 0
    };

    try {
      await executor.execute({
        model: "test-model",
        body: {},
        stream: false,
        credentials: {},
        signal: new AbortController().signal,
        log: { debug: () => {} },
        retryBudget
      });
    } catch (err) {
      // Expect 502 error
    }

    expect(mockProxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(retryBudget.totalAttempts).toBe(1);
  });

  // Test 3 — không fanout account cùng model
  it("Test 3 — không fanout account cùng model: handleSingleModelChat returns SWITCH_MODEL_OR_PROVIDER immediately on 502", async () => {
    const chatModule = await import("../../src/sse/handlers/chat.js");
    const handleSingleModelChat = chatModule.handleSingleModelChat || chatModule.default || chatModule;

    // Create two connections in DB
    const conn1 = await sqliteDb.createProviderConnection({
      provider: "test-no-fanout",
      authType: "apikey",
      name: `conn1-${Math.random()}`,
      apiKey: "token1"
    });
    const conn2 = await sqliteDb.createProviderConnection({
      provider: "test-no-fanout",
      authType: "apikey",
      name: `conn2-${Math.random()}`,
      apiKey: "token2"
    });

    // Mock proxyAwareFetch to return 502 Bad Gateway
    mockProxyAwareFetch.mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ error: { message: "fetch connect timeout" } }), { status: 502 })
    ));

    const retryBudget = {
      isComboPath: true,
      maxExecutorRetries: 0,
      maxAccountsPerModel: 1,
      totalAttempts: 0
    };

    try {
      const resp = await handleSingleModelChat(
        {},
        "test-no-fanout/test-model",
        null,
        null,
        null,
        { retryBudget }
      );

      // Verify that decision to switch candidate model is returned
      expect(resp.decision).toBeDefined();
      expect(resp.decision.action).toBe("SWITCH_MODEL_OR_PROVIDER");

      // Verify only 1 account was tried (no second fetch call)
      expect(mockProxyAwareFetch).toHaveBeenCalledTimes(1);
    } finally {
      await sqliteDb.deleteProviderConnection(conn1.id);
      await sqliteDb.deleteProviderConnection(conn2.id);
    }
  });

  // Test 4 — 429 account lock, provider skip only by ratio
  it("Test 4 — 429 account lock, provider skip only by ratio: 429 locks account, doesn't cooldown provider if ratio < 0.8", async () => {
    // Create 3 active NVIDIA connections in DB
    const conn1 = await sqliteDb.createProviderConnection({
      provider: "nvidia-test-4",
      authType: "apikey",
      name: `nv1-${Math.random()}`,
      apiKey: "nv-tok-1"
    });
    const conn2 = await sqliteDb.createProviderConnection({
      provider: "nvidia-test-4",
      authType: "apikey",
      name: `nv2-${Math.random()}`,
      apiKey: "nv-tok-2"
    });
    const conn3 = await sqliteDb.createProviderConnection({
      provider: "nvidia-test-4",
      authType: "apikey",
      name: `nv3-${Math.random()}`,
      apiKey: "nv-tok-3"
    });

    try {
      // Simulate 429 for one NVIDIA account
      await markAccountUnavailable(conn1.id, 429, "rate_limit_exceeded", "nvidia-test-4", "test-model");

      // Verify the connection health is updated to RATE_LIMITED
      const updatedConn1 = await sqliteDb.getProviderConnectionById(conn1.id);
      expect(updatedConn1.connectionHealth).toBe(ConnectionHealth.RATE_LIMITED);

      // Since only 1 of 3 accounts is rate-limited (ratio = 1/3 = 0.33 < 0.8), provider should not be on cooldown
      expect(providerCooldowns.has("nvidia-test-4")).toBe(false);
    } finally {
      await sqliteDb.deleteProviderConnection(conn1.id);
      await sqliteDb.deleteProviderConnection(conn2.id);
      await sqliteDb.deleteProviderConnection(conn3.id);
    }
  });

  // Test 5 — 410 locks model long
  it("Test 5 — 410 locks model long: 410 Gone locks model across all accounts of the provider", async () => {
    const conn1 = await sqliteDb.createProviderConnection({
      provider: "nvidia-test-5",
      authType: "apikey",
      name: `nv1-${Math.random()}`,
      apiKey: "nv-tok-1"
    });
    const conn2 = await sqliteDb.createProviderConnection({
      provider: "nvidia-test-5",
      authType: "apikey",
      name: `nv2-${Math.random()}`,
      apiKey: "nv-tok-2"
    });

    try {
      // Simulate 410 Gone for test-model
      await markAccountUnavailable(conn1.id, 410, "Gone", "nvidia-test-5", "test-model");

      // Verify the model lock is set for both connections
      const updated1 = await sqliteDb.getProviderConnectionById(conn1.id);
      const updated2 = await sqliteDb.getProviderConnectionById(conn2.id);

      expect(updated1["modelLock_test-model"]).toBeDefined();
      expect(updated2["modelLock_test-model"]).toBeDefined();
    } finally {
      await sqliteDb.deleteProviderConnection(conn1.id);
      await sqliteDb.deleteProviderConnection(conn2.id);
    }
  });

  // Test 6 — retry budget exhausted
  it("Test 6 — retry budget exhausted: handleComboChat stops and returns error when totalAttempts >= maxTotalAttempts", async () => {
    const logMock = { info: () => {}, warn: () => {} };

    // Simulate handleSingleModel that increments totalAttempts
    const handleSingleModelMock = vi.fn(async (body, modelStr, options) => {
      options.retryBudget.totalAttempts++;
      return new Response(JSON.stringify({ error: "Failed" }), { status: 502 });
    });

    const result = await handleComboChat({
      body: {},
      models: ["nvidia/model-1", "nvidia/model-2", "nvidia/model-3", "nvidia/model-5", "nvidia/model-6"],
      handleSingleModel: handleSingleModelMock,
      log: logMock,
      comboName: "test-combo",
      comboStrategy: "fallback"
    });

    // Verify it returned retry_budget_exhausted response
    expect(result.status).toBe(503);
    const body = await result.json();
    expect(body.error.code).toBe("retry_budget_exhausted");

    // Verify only 4 attempts were made
    expect(handleSingleModelMock).toHaveBeenCalledTimes(4);
  });
});
