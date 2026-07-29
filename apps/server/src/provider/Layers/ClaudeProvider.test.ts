import { describe, expect, it } from "@effect/vitest";

import { normalizeClaudeCliEffort } from "./ClaudeProvider.ts";

describe("normalizeClaudeCliEffort", () => {
  it("filters the legacy ultrathink effort value", () => {
    expect(normalizeClaudeCliEffort("ultrathink", "claude-opus-5")).toBeUndefined();
  });

  it("preserves supported effort values", () => {
    expect(normalizeClaudeCliEffort("high", "claude-opus-5")).toBe("high");
  });
});
