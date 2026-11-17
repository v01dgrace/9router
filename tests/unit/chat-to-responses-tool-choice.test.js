import { describe, expect, it } from "vitest";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";

const tool = (name) => ({ type: "function", function: { name, description: "d", parameters: { type: "object", properties: {} } } });
const run = (tool_choice, tools = [tool("read"), tool("edit")]) =>
  openaiToOpenAIResponsesRequest("m", { messages: [{ role: "user", content: "hi" }], tools, tool_choice }, true, {});

describe("#5718 chat -> Responses tool_choice", () => {
  it("passes string choices through", () => {
    for (const c of ["auto", "required", "none"]) expect(run(c).tool_choice).toBe(c);
  });
  it("flattens a named function choice", () => {
    expect(run({ type: "function", function: { name: "read" } }).tool_choice).toEqual({ type: "function", name: "read" });
  });
  it("collapses {type:required} shorthand to the bare string", () => {
    expect(run({ type: "required" }).tool_choice).toBe("required");
  });
  it("drops a named choice whose tool is not declared (no dangling reference upstream)", () => {
    expect(run({ type: "function", function: { name: "ghost" } }).tool_choice).toBeUndefined();
    expect(run({ type: "function", function: { name: "read" } }, []).tool_choice).toBeUndefined();
  });
  it("leaves tool_choice absent when the client sent none", () => {
    expect("tool_choice" in run(undefined)).toBe(false);
  });
});

describe("#5718 body already in Responses shape (input[] present)", () => {
  const input = [{ type: "message", role: "user", content: "hi" }];
  const run = (tool_choice, tools) =>
    openaiToOpenAIResponsesRequest("m", { input, tools, tool_choice }, true, {});
  const flatTool = (name) => ({ type: "function", name, parameters: { type: "object", properties: {} } });

  it("flattens a chat-shaped named choice just like the messages path", () => {
    expect(run({ type: "function", function: { name: "read" } }, [flatTool("read")]).tool_choice)
      .toEqual({ type: "function", name: "read" });
  });
  it("keeps a valid choice when tools are chat-shaped (nested) rather than dropping it", () => {
    expect(run({ type: "function", function: { name: "read" } }, [tool("read")]).tool_choice)
      .toEqual({ type: "function", name: "read" });
  });
  it("keeps an already-flat Responses choice", () => {
    expect(run({ type: "function", name: "read" }, [flatTool("read")]).tool_choice)
      .toEqual({ type: "function", name: "read" });
  });
  it("passes string choices through and drops a dangling name", () => {
    expect(run("required", [flatTool("read")]).tool_choice).toBe("required");
    expect(run({ type: "function", function: { name: "ghost" } }, [flatTool("read")]).tool_choice).toBeUndefined();
  });
});
