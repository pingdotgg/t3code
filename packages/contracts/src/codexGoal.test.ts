import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { CODEX_GOAL_OBJECTIVE_MAX_CHARS, CodexGoalSetInput } from "./codexGoal.ts";

const decodeSetInput = Schema.decodeUnknownSync(CodexGoalSetInput);

describe("CodexGoalSetInput", () => {
  it("matches Codex's positive token budget constraint", () => {
    expect(decodeSetInput({ threadId: "thread-1", tokenBudget: 1 }).tokenBudget).toBe(1);
    expect(decodeSetInput({ threadId: "thread-1", tokenBudget: null }).tokenBudget).toBeNull();
    expect(() => decodeSetInput({ threadId: "thread-1", tokenBudget: 0 })).toThrow();
  });

  it("matches Codex's 4,000 Unicode-character objective limit", () => {
    const maximum = "😀".repeat(CODEX_GOAL_OBJECTIVE_MAX_CHARS);
    expect(decodeSetInput({ threadId: "thread-1", objective: maximum }).objective).toBe(maximum);
    expect(() => decodeSetInput({ threadId: "thread-1", objective: `${maximum}x` })).toThrow();
  });
});
