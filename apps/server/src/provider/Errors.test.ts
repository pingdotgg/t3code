import { describe, expect, it } from "vite-plus/test";

import { classifyRecoverableThreadFailure } from "./Errors.ts";

describe("classifyRecoverableThreadFailure", () => {
  it.each([
    ["Authentication required: sign in again", "authentication"],
    ["401 Unauthorized", "authentication"],
    ["API key is expired", "authentication"],
    ["Model not available: gpt-example", "model_unavailable"],
    ["unknown model named legacy-model", "model_unavailable"],
  ] as const)("classifies %s as %s", (detail, expected) => {
    expect(classifyRecoverableThreadFailure(detail)).toBe(expected);
  });

  it("does not make generic provider failures recoverable", () => {
    expect(
      classifyRecoverableThreadFailure("Provider process exited unexpectedly"),
    ).toBeUndefined();
  });
});
