import { describe, expect, it } from "vitest";
import { resolveStream } from "../../open-sse/handlers/chatCore/streamMode.js";
import { EYEBALLS_ATTEMPT_TIMEOUT_MS, parseEyeballsTimeoutMs } from "../../open-sse/utils/proxyFetch.js";

const decide = (body, extra = {}) =>
  resolveStream({ body, clientRequestedStreaming: body.stream === true, providerRequiresStreaming: false, ...extra });

describe("#5677 resolveStream", () => {
  it("treats absent stream as false for OpenAI/Claude-style clients", () => {
    expect(decide({})).toBe(false);
    expect(decide({ stream: undefined })).toBe(false);
    expect(decide({ stream: null })).toBe(false);
  });
  it("honours explicit values", () => {
    expect(decide({ stream: true })).toBe(true);
    expect(decide({ stream: false })).toBe(false);
  });
  it("streams absent-stream requests from Gemini-style source formats", () => {
    expect(decide({}, { clientRequestedStreaming: true })).toBe(true);
  });
  it("forceStream providers always stream", () => {
    expect(decide({ stream: false }, { providerRequiresStreaming: true })).toBe(true);
    expect(decide({}, { providerRequiresStreaming: true })).toBe(true);
  });
});

describe("#5721 happy-eyeballs budget", () => {
  it("is above a ~285ms intercontinental RTT", () => {
    expect(EYEBALLS_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(300);
  });
});

describe("#5721 NINEROUTER_HAPPY_EYEBALLS_TIMEOUT_MS parsing", () => {
  it("accepts sane integers", () => {
    expect(parseEyeballsTimeoutMs("2500")).toBe(2500);
  });
  it("falls back to the default for missing, malformed or out-of-range values", () => {
    for (const bad of [undefined, "", "abc", "12.5", "-5", "0", "50", "999999"]) {
      expect(parseEyeballsTimeoutMs(bad), String(bad)).toBe(1000);
    }
  });
});
