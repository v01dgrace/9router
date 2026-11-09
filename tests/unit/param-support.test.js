import { describe, it, expect } from "vitest";

import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";

describe("stripUnsupportedParams", () => {
  it("flattens Cloudflare AI OpenAI content-part arrays", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello " },
            { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
            { type: "text", text: "world" },
          ],
        },
      ],
    };

    expect(() => stripUnsupportedParams("cloudflare-ai", "@cf/meta/llama-3.1-8b-instruct", body)).not.toThrow();
    expect(body.messages[0].content).toBe("hello world");
  });

  it("flattens Cloudflare AI content-part arrays and fixes null/undefined content using alias 'cf'", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello " },
            "plain string ",
            { content: "from content field " },
            { type: "text", text: "world" },
          ],
        },
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "test", arguments: "{}" } }],
        },
        {
          role: "assistant",
          content: null,
        },
      ],
    };

    stripUnsupportedParams("cf", "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", body);
    expect(body.messages[0].content).toBe("hello plain string from content field world");
    expect(body.messages[1].content).toBe("");
    expect(body.messages[2].content).toBe("");
  });

  it("normalizes messages via DefaultExecutor transformRequest for cloudflare-ai / cf", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const executor = new DefaultExecutor("cloudflare-ai");
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "query 1" }] },
        { role: "assistant", content: [{ type: "text", text: "reply 1" }] },
        { role: "user", content: [{ type: "text", text: "query 2" }] },
        { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "fn" } }] },
      ],
    };

    const transformed = executor.transformRequest("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", body);
    expect(typeof transformed.messages[0].content).toBe("string");
    expect(transformed.messages[0].content).toBe("query 1");
    expect(typeof transformed.messages[1].content).toBe("string");
    expect(transformed.messages[1].content).toBe("reply 1");
    expect(typeof transformed.messages[2].content).toBe("string");
    expect(transformed.messages[2].content).toBe("query 2");
    expect(typeof transformed.messages[3].content).toBe("string");
    expect(transformed.messages[3].content).toBe("");
  });

  it("still drops unsupported GitHub model params", () => {
    const body = { temperature: 0.7, top_p: 1 };

    stripUnsupportedParams("github", "gpt-5.4", body);

    expect(body).toEqual({ top_p: 1 });
  });

  it("clamps VolcEngine Ark GLM max token fields to the model output ceiling", () => {
    const body = {
      max_tokens: 131072,
      max_completion_tokens: 131072,
      max_output_tokens: 131072,
    };

    stripUnsupportedParams("volcengine-ark", "GLM-5.2", body);

    expect(body).toEqual({
      max_tokens: 128000,
      max_completion_tokens: 128000,
      max_output_tokens: 128000,
    });
  });

  it("keeps VolcEngine Ark GLM max tokens when already under the ceiling", () => {
    const body = { max_tokens: 64000 };

    stripUnsupportedParams("volcengine-ark", "GLM-5.2", body);

    expect(body.max_tokens).toBe(64000);
  });
});
