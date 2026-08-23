import { ThreadId, type CodexGoal, type CodexGoalStreamEvent } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  applyCodexGoalStreamEvent,
  formatCodexGoalDescription,
  formatCodexGoalError,
  formatCodexGoalStatus,
  formatCodexGoalUsage,
  parseCodexGoalCommand,
  toCodexGoalSubscriptionTarget,
} from "./threadCommands.ts";

const threadId = ThreadId.make("thread-1");
const goal = (objective: string): CodexGoal => ({
  objective,
  status: "active",
  tokenBudget: 100_000,
  tokensUsed: 12_000,
  timeUsedSeconds: 90,
  createdAt: 1_777_000_000,
  updatedAt: 1_777_000_090,
});

describe("parseCodexGoalCommand", () => {
  it("maps all supported Goal commands to native mutations", () => {
    const cases = [
      ["/goal", { action: "status" }],
      ["/goal status", { action: "status" }],
      ["/goal create Ship it", { action: "set", objective: "Ship it", status: "active" }],
      ["/goal Ship it", { action: "set", objective: "Ship it", status: "active" }],
      ["/goal steer Narrow the patch", { action: "set", objective: "Narrow the patch" }],
      ["/goal edit Narrow the patch", { action: "set", objective: "Narrow the patch" }],
      ["/goal pause", { action: "set", status: "paused" }],
      ["/goal resume", { action: "set", status: "active" }],
      ["/goal clear", { action: "clear" }],
      ["/goal reset", { action: "clear" }],
      [
        "/goal edit",
        {
          action: "invalid",
          message: "T3 does not open Codex's Goal editor. Use /goal steer <objective>.",
        },
      ],
      ["please create a goal", null],
    ] as const;
    for (const [command, expected] of cases) {
      expect(parseCodexGoalCommand(command)).toEqual(expected);
    }
  });
});

describe("toCodexGoalSubscriptionTarget", () => {
  it("keys Goal refreshes only by environment and thread", () => {
    expect(
      toCodexGoalSubscriptionTarget({
        environmentId: "environment-1",
        input: {
          threadId: "thread-1",
          objective: "Do not leak into the subscription key",
          status: "active",
        },
      }),
    ).toEqual({ environmentId: "environment-1", input: { threadId: "thread-1" } });
  });
});

describe("applyCodexGoalStreamEvent", () => {
  it("formats native usage consistently for clients", () => {
    expect(formatCodexGoalDescription(goal("Ship it"))).toBe(
      "Ship it - 12,000 tokens / 100,000, 90 seconds",
    );
  });

  it("formats native statuses as user-facing labels", () => {
    const statuses = [
      "active",
      "paused",
      "budgetLimited",
      "usageLimited",
      "complete",
      "blocked",
    ] as const;
    expect(statuses.map(formatCodexGoalStatus)).toEqual([
      "active",
      "paused",
      "budget limited",
      "usage limited",
      "complete",
      "blocked",
    ]);
  });

  it("applies native updated and cleared notifications", () => {
    const initial = { goal: null, hasNativeUpdate: false };
    const updated = applyCodexGoalStreamEvent(initial, {
      type: "updated",
      threadId,
      goal: goal("Updated asynchronously"),
    });
    expect(updated.goal?.objective).toBe("Updated asynchronously");
    expect(applyCodexGoalStreamEvent(updated, { type: "cleared", threadId }).goal).toBeNull();
  });

  it("does not let a late snapshot overwrite a live native update", () => {
    const updated = applyCodexGoalStreamEvent(
      { goal: null, hasNativeUpdate: false },
      {
        type: "updated",
        threadId,
        goal: goal("Live update"),
      },
    );
    const lateSnapshot: CodexGoalStreamEvent = {
      type: "snapshot",
      threadId,
      goal: goal("Stale snapshot"),
    };
    expect(applyCodexGoalStreamEvent(updated, lateSnapshot).goal?.objective).toBe("Live update");
  });
});

describe("formatCodexGoalError", () => {
  it("appends the provider reason carried in the error cause", () => {
    const error = new Error("Codex Goal set failed for thread thread-1", {
      cause: new Error("Provider 'claude' is not implemented"),
    });
    expect(formatCodexGoalError(error)).toBe(
      "Codex Goal set failed for thread thread-1: Provider 'claude' is not implemented",
    );
  });

  it("falls back to the wrapper message when the cause carries no reason", () => {
    expect(formatCodexGoalError(new Error("Codex Goal get failed for thread thread-1"))).toBe(
      "Codex Goal get failed for thread thread-1",
    );
  });

  it("handles non-error failures", () => {
    expect(formatCodexGoalError("boom")).toBe("Codex Goal operation failed.");
  });
});

describe("formatCodexGoalUsage", () => {
  it("renders the budget when one is set", () => {
    expect(formatCodexGoalUsage(goal("Ship it"))).toBe("12,000 tokens / 100,000, 90 seconds");
  });

  it("omits the budget when there is none", () => {
    expect(formatCodexGoalUsage({ ...goal("Ship it"), tokenBudget: null })).toBe(
      "12,000 tokens, 90 seconds",
    );
  });

  it("is the usage half of the full description", () => {
    const withBudget = goal("Ship it");
    expect(formatCodexGoalDescription(withBudget)).toBe(
      `Ship it - ${formatCodexGoalUsage(withBudget)}`,
    );
  });
});
