import { describe, expect, it } from "vite-plus/test";
import { executeThreadUndo, planThreadUndo } from "./threadUndo.ts";

describe("planThreadUndo", () => {
  it("restores a snooze with no wake time after undoing a settle", async () => {
    const now = "2026-11-17T02:00:00Z";
    const snoozed = {
      snoozedAt: "2026-11-17T00:00:00Z",
      snoozedUntil: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
    };
    // A question asked since the snooze woke the thread; Undo leaves it awake.
    expect(
      planThreadUndo(
        "settle",
        { ...snoozed, hasPendingUserInput: true, pendingUserInputAt: "2026-11-17T01:00:00Z" },
        now,
      ),
    ).toEqual([{ action: "unsettle", restoreUnsettledAt: null }]);
    const plan = planThreadUndo("settle", snoozed, now);
    expect(plan).toEqual([
      { action: "unsettle", restoreUnsettledAt: null },
      { action: "snooze", snoozedUntil: null },
    ]);
    const executed: string[] = [];
    await executeThreadUndo(
      plan,
      async (step) => {
        executed.push(step.action);
        return true;
      },
      (result) => result,
    );
    expect(executed).toEqual(["unsettle", "snooze"]);
  });
});
