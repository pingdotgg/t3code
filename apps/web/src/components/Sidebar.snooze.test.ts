import { describe, expect, it } from "vite-plus/test";

import { rescheduleUndoTarget } from "./Sidebar.snooze";

describe("rescheduleUndoTarget", () => {
  const now = new Date("2026-04-08T10:00:00Z");
  const awakeShell = {
    snoozedUntil: null,
    snoozedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    latestTurn: null,
  };

  it("returns the current wake time while the thread is still snoozed", () => {
    expect(
      rescheduleUndoTarget(
        { ...awakeShell, snoozedUntil: "2026-04-09T09:00:00Z", snoozedAt: "2026-04-08T09:00:00Z" },
        now,
      ),
    ).toBe("2026-04-09T09:00:00Z");
  });

  it("returns null for an awake thread so undo wakes instead", () => {
    expect(rescheduleUndoTarget(awakeShell, now)).toBeNull();
    expect(rescheduleUndoTarget(null, now)).toBeNull();
  });

  it("treats an already-passed wake time as awake", () => {
    expect(
      rescheduleUndoTarget(
        { ...awakeShell, snoozedUntil: "2026-04-08T09:00:00Z", snoozedAt: "2026-04-07T09:00:00Z" },
        now,
      ),
    ).toBeNull();
  });
});
