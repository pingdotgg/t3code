import { describe, expect, it } from "vite-plus/test";
import { executeThreadUndo, planThreadUndo } from "./threadUndo.ts";

describe("planThreadUndo", () => {
  it("restores a snooze with no wake time after undoing a settle", async () => {
    const plan = planThreadUndo("settle", {
      snoozedAt: "2026-11-17T00:00:00Z",
      snoozedUntil: null,
    });
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
