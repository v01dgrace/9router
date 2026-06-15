import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalFetch = global.fetch;

describe("NVIDIA NIM discovery filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("filters chat models that return NVIDIA function-not-found for the account", async () => {
    const { filterCallableNimModels } = await import("../../open-sse/services/nvidiaDiscovery.js");

    global.fetch = vi.fn((url, options) => {
      const body = JSON.parse(options.body);
      if (body.model === "bad/model") {
        return Promise.resolve(new Response(JSON.stringify({
          status: 404,
          title: "Not Found",
          detail: "Function '7dfc10a8-3cc4-448e-97c1-2213308dc222': Not found for account 'acct'",
        }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    });

    const models = [
      { id: "good/model", name: "Good" },
      { id: "bad/model", name: "Bad" },
      { id: "nvidia/nv-embedqa-e5-v5", name: "Embed" },
    ];

    const result = await filterCallableNimModels(models, "nvapi-test");

    expect(result.models.map((model) => model.id)).toEqual([
      "good/model",
      "nvidia/nv-embedqa-e5-v5",
    ]);
    expect(result.filtered).toEqual([
      expect.objectContaining({ id: "bad/model", reason: "function_not_found" }),
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
