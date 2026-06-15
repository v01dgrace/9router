import { describe, it, expect } from "vitest";
import { isFatalModelError } from "../../src/sse/services/auth.js";

describe("auth error classification", () => {
  it("treats NVIDIA function-not-found errors as fatal model errors", () => {
    expect(isFatalModelError(
      404,
      "Function '7dfc10a8-3cc4-448e-97c1-2213308dc222': Not found for account 'acct'",
    )).toBe(true);
  });
});
