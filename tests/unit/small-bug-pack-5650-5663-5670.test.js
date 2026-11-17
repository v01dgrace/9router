import { describe, expect, it, vi, afterEach } from "vitest";
import { ANTIGRAVITY_PROMPT_REWRITES } from "../../open-sse/config/appConstants.js";
import { handleSttCore } from "../../open-sse/handlers/sttCore.js";
import { fmtTokens } from "../../src/shared/utils/fmtTokens.js";

const rewrite = (text) =>
  ANTIGRAVITY_PROMPT_REWRITES.reduce((t, { from, to }) => t.replace(from, to), text);

describe("#5650 antigravity opencode rewrite keeps paths and identifiers", () => {
  it("still rewrites standalone brand mentions", () => {
    expect(rewrite("You are OpenCode.")).toBe("You are Antigravity.");
    expect(rewrite("use opencode now")).toBe("use antigravity now");
    expect(rewrite("OPENCODE")).toBe("ANTIGRAVITY");
  });
  it("leaves paths, flags and identifiers alone", () => {
    for (const s of ["/home/u/.config/opencode/auth.json", "opencode-go", "my-opencode", "opencode_cli", "opencode.json", "@opencode/sdk"]) {
      expect(rewrite(s)).toBe(s);
    }
  });
});

describe("#5663 STT forwards timestamp_granularities[]", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("appends every granularity to the upstream multipart body", async () => {
    let sent;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      sent = init.body;
      return new Response(JSON.stringify({ text: "x" }), { headers: { "content-type": "application/json" } });
    }));
    const formData = new FormData();
    formData.append("file", new File(["a"], "a.wav", { type: "audio/wav" }));
    formData.append("timestamp_granularities[]", "word");
    formData.append("timestamp_granularities[]", "segment");
    await handleSttCore({
      provider: "groq", model: "whisper-large-v3", formData, credentials: { apiKey: "k" },
      sttConfig: { baseUrl: "https://example.test/v1/audio/transcriptions", format: "openai" },
    });
    expect(sent.getAll("timestamp_granularities[]")).toEqual(["word", "segment"]);
  });

  const forwarded = async (values) => {
    let sent;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      sent = init.body;
      return new Response(JSON.stringify({ text: "x" }), { headers: { "content-type": "application/json" } });
    }));
    const formData = new FormData();
    formData.append("file", new File(["a"], "a.wav", { type: "audio/wav" }));
    for (const v of values) formData.append("timestamp_granularities[]", v);
    await handleSttCore({
      provider: "groq", model: "whisper-large-v3", formData, credentials: { apiKey: "k" },
      sttConfig: { baseUrl: "https://example.test/v1/audio/transcriptions", format: "openai" },
    });
    return sent.getAll("timestamp_granularities[]");
  };

  it("forwards only the values Groq and OpenAI document (word, segment), once each", async () => {
    expect(await forwarded(["word", "bogus", "segment", "word", "<script>"])).toEqual(["word", "segment"]);
  });
  it("sends no granularity at all when none is valid", async () => {
    expect(await forwarded(["bogus", ""])).toEqual([]);
  });
  it("does not forward an unbounded number of parts", async () => {
    expect(await forwarded(Array(500).fill("word"))).toEqual(["word"]);
  });
});

describe("#5670 fmtTokens handles billions", () => {
  it("formats B, M, K and small values", () => {
    expect(fmtTokens(1_500_000_000)).toBe("1.5B");
    expect(fmtTokens(2_300_000)).toBe("2.3M");
    expect(fmtTokens(4_500)).toBe("4.5K");
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(undefined)).toBe("0");
  });
});
