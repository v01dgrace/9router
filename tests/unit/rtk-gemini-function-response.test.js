import { describe, expect, it } from "vitest";
import { compressMessages } from "../../open-sse/rtk/index.js";

// Repetitive npm-warn noise: the same shape RTK already compresses for Kiro.
const NOISY = Array.from({ length: 60 }, (_, i) => `npm warn deprecated pkg${i}@1.0.${i}: this library is no longer supported`).join("\n");

const fr = (response, name = "run") => ({ role: "user", parts: [{ functionResponse: { name, response } }] });

describe("#5674 RTK compresses Gemini functionResponse", () => {
  it.each([
    ["gemini/vertex: body.contents", (c) => ({ contents: c })],
    ["antigravity/gemini-cli: body.request.contents", (c) => ({ request: { contents: c } })],
  ])("shrinks a plain-text result (%s)", (_label, wrap) => {
    const contents = [fr({ output: NOISY })];
    const body = wrap(contents);
    const stats = compressMessages(body, true);
    expect(stats).not.toBeNull();
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
    expect(contents[0].parts[0].functionResponse.response.output.length).toBeLessThan(NOISY.length);
  });

  it("compresses each known field name", () => {
    for (const field of ["result", "output", "content", "text"]) {
      const contents = [fr({ [field]: NOISY })];
      compressMessages({ contents }, true);
      expect(contents[0].parts[0].functionResponse.response[field].length, field).toBeLessThan(NOISY.length);
    }
  });

  it("leaves error payloads untouched", () => {
    for (const response of [{ error: NOISY, output: NOISY }, { is_error: true, output: NOISY }, { status: "error", output: NOISY }]) {
      const contents = [fr(response)];
      compressMessages({ contents }, true);
      expect(contents[0].parts[0].functionResponse.response.output).toBe(NOISY);
    }
  });

  it("leaves serialized JSON strings untouched", () => {
    const json = JSON.stringify({ rows: Array.from({ length: 80 }, (_, i) => ({ i, v: "x".repeat(10) })) });
    const contents = [fr({ output: json })];
    compressMessages({ contents }, true);
    expect(contents[0].parts[0].functionResponse.response.output).toBe(json);
  });

  it("does not touch model text or functionCall parts", () => {
    const contents = [{ role: "model", parts: [{ text: NOISY }, { functionCall: { name: "run", args: { cmd: NOISY } } }] }];
    compressMessages({ contents }, true);
    expect(contents[0].parts[0].text).toBe(NOISY);
    expect(contents[0].parts[1].functionCall.args.cmd).toBe(NOISY);
  });

  it("is a no-op when disabled and fails open on malformed shapes", () => {
    const contents = [fr({ output: NOISY })];
    expect(compressMessages({ contents }, false)).toBeNull();
    expect(contents[0].parts[0].functionResponse.response.output).toBe(NOISY);
    expect(() => compressMessages({ contents: [null, { parts: null }, { parts: [null, {}] }] }, true)).not.toThrow();
  });

  it("bounds traversal depth", () => {
    let deep = { output: NOISY };
    for (let i = 0; i < 12; i++) deep = { content: deep };
    const contents = [fr(deep)];
    compressMessages({ contents }, true);
    let node = contents[0].parts[0].functionResponse.response;
    for (let i = 0; i < 12; i++) node = node.content;
    expect(node.output).toBe(NOISY);
  });
});
