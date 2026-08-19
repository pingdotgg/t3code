import { describe, expect, it } from "vite-plus/test";

import {
  buildGoalContinuationPrompt,
  countTrailingEmptyGoalContinuations,
  goalBlockCommandId,
  goalContinuationCommandId,
  isProviderAccountUsageLimitError,
  parseObjectiveSignal,
} from "./goalContinuation.ts";

describe("buildGoalContinuationPrompt", () => {
  it("names the Objective and complete/blocked markers without saying goal", () => {
    const objective = "Reduce p95 below 120ms";
    const prompt = buildGoalContinuationPrompt(objective);
    expect(prompt).toContain(objective);
    expect(prompt).toContain("<objective_complete>");
    expect(prompt).toContain("</objective_complete>");
    expect(prompt).toContain("<objective_blocked>");
    expect(prompt).toContain("</objective_blocked>");
    expect(prompt).not.toMatch(/\bgoal\b/i);
    expect(prompt.toLowerCase()).not.toContain("/goal");
    expect(prompt.toLowerCase()).not.toContain("slash goal");
  });

  it("interpolates replacement-token characters in the Objective literally", () => {
    const objective = "Replace $& with $` and $' plus $1";
    const prompt = buildGoalContinuationPrompt(objective);
    expect(prompt).toContain(objective);
    expect(prompt).not.toContain("Continue working toward this Objective until $1");
  });
});

describe("goalContinuationCommandId", () => {
  const input = {
    threadId: "thread-1",
    goalUpdatedAt: "2026-01-01T00:00:00.000Z",
    completedTurnId: "turn-1",
  } as const;

  it("is stable per Goal generation and completed Turn", () => {
    expect(goalContinuationCommandId(input)).toBe(
      "goal-continue:thread-1:2026-01-01T00:00:00.000Z:turn-1",
    );
    expect(goalContinuationCommandId(input)).toBe(goalContinuationCommandId({ ...input }));
  });

  it("differs when completedTurnId or goalUpdatedAt changes", () => {
    const baseline = goalContinuationCommandId(input);
    expect(
      goalContinuationCommandId({
        ...input,
        completedTurnId: "turn-2",
      }),
    ).not.toBe(baseline);
    expect(
      goalContinuationCommandId({
        ...input,
        goalUpdatedAt: "2026-01-02T00:00:00.000Z",
      }),
    ).not.toBe(baseline);
  });
});

describe("goalBlockCommandId", () => {
  it("is stable per Goal generation and completed Turn", () => {
    expect(
      goalBlockCommandId({
        threadId: "thread-1",
        goalUpdatedAt: "2026-01-01T00:00:00.000Z",
        completedTurnId: "turn-1",
      }),
    ).toBe("goal-block:thread-1:2026-01-01T00:00:00.000Z:turn-1");
  });
});

describe("isProviderAccountUsageLimitError", () => {
  it("detects account quota and rate-limit Turn errors", () => {
    expect(isProviderAccountUsageLimitError("HTTP 429 Too Many Requests")).toBe(true);
    expect(isProviderAccountUsageLimitError("rate_limit_reached")).toBe(true);
    expect(isProviderAccountUsageLimitError("You have exceeded your current quota")).toBe(true);
    expect(isProviderAccountUsageLimitError("workspace_member_usage_limit_reached")).toBe(true);
    expect(isProviderAccountUsageLimitError("RESOURCE_EXHAUSTED")).toBe(true);
  });

  it("does not treat ordinary Turn errors as Usage-limited", () => {
    expect(isProviderAccountUsageLimitError("turn failed")).toBe(false);
    expect(isProviderAccountUsageLimitError("Permission denied")).toBe(false);
    expect(isProviderAccountUsageLimitError(null)).toBe(false);
  });
});

describe("parseObjectiveSignal", () => {
  it("reads Complete and Blocked tags and ignores prose", () => {
    expect(parseObjectiveSignal("we're done")).toBeNull();
    expect(parseObjectiveSignal("I'm stuck")).toBeNull();
    expect(parseObjectiveSignal("<objective_complete>p95 is 90ms</objective_complete>")).toBe(
      "complete",
    );
    expect(parseObjectiveSignal("<objective_blocked>tests fail</objective_blocked>")).toBe(
      "blocked",
    );
  });

  it("uses the first tag when both are present", () => {
    expect(
      parseObjectiveSignal(
        "<objective_blocked>nope</objective_blocked>\n<objective_complete>later</objective_complete>",
      ),
    ).toBe("blocked");
  });
});

describe("countTrailingEmptyGoalContinuations", () => {
  const NOW = "2026-01-01T00:03:00.000Z";

  it("does not count the originating user Turn", () => {
    expect(
      countTrailingEmptyGoalContinuations(
        {
          activities: [
            {
              kind: "goal.set",
              tone: "info",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          checkpoints: [],
        },
        NOW,
      ),
    ).toBe(0);
  });

  it("counts consecutive empty Continuations and resets after Resume or progress", () => {
    expect(
      countTrailingEmptyGoalContinuations(
        {
          activities: [
            { kind: "goal.set", tone: "info", createdAt: "2026-01-01T00:00:00.000Z" },
            { kind: "goal.continued", tone: "info", createdAt: "2026-01-01T00:01:00.000Z" },
            { kind: "goal.continued", tone: "info", createdAt: "2026-01-01T00:02:00.000Z" },
            { kind: "goal.continued", tone: "info", createdAt: "2026-01-01T00:03:00.000Z" },
          ],
          checkpoints: [],
        },
        "2026-01-01T00:04:00.000Z",
      ),
    ).toBe(3);

    expect(
      countTrailingEmptyGoalContinuations(
        {
          activities: [
            { kind: "goal.set", tone: "info", createdAt: "2026-01-01T00:00:00.000Z" },
            { kind: "goal.continued", tone: "info", createdAt: "2026-01-01T00:01:00.000Z" },
            { kind: "goal.continued", tone: "info", createdAt: "2026-01-01T00:02:00.000Z" },
            { kind: "tool.completed", tone: "tool", createdAt: "2026-01-01T00:02:30.000Z" },
            { kind: "goal.continued", tone: "info", createdAt: "2026-01-01T00:03:00.000Z" },
          ],
          checkpoints: [],
        },
        "2026-01-01T00:04:00.000Z",
      ),
    ).toBe(1);

    expect(
      countTrailingEmptyGoalContinuations(
        {
          activities: [
            { kind: "goal.set", tone: "info", createdAt: "2026-01-01T00:00:00.000Z" },
            { kind: "goal.continued", tone: "info", createdAt: "2026-01-01T00:01:00.000Z" },
            { kind: "goal.continued", tone: "info", createdAt: "2026-01-01T00:02:00.000Z" },
            { kind: "goal.continued", tone: "info", createdAt: "2026-01-01T00:03:00.000Z" },
            { kind: "goal.resumed", tone: "info", createdAt: "2026-01-01T00:05:00.000Z" },
            { kind: "goal.continued", tone: "info", createdAt: "2026-01-01T00:06:00.000Z" },
          ],
          checkpoints: [],
        },
        "2026-01-01T00:07:00.000Z",
      ),
    ).toBe(1);
  });

  it("treats a non-empty checkpoint diff as progress", () => {
    expect(
      countTrailingEmptyGoalContinuations(
        {
          activities: [
            { kind: "goal.set", tone: "info", createdAt: "2026-01-01T00:00:00.000Z" },
            { kind: "goal.continued", tone: "info", createdAt: "2026-01-01T00:01:00.000Z" },
          ],
          checkpoints: [
            {
              files: [{ additions: 3, deletions: 1 }],
              completedAt: "2026-01-01T00:01:30.000Z",
            },
          ],
        },
        NOW,
      ),
    ).toBe(0);
  });
});
