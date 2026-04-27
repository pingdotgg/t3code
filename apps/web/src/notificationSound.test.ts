import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  NOTIFICATION_THROTTLE_MS,
  deriveNotificationTriggers,
  shouldPlay,
  type NotificationFocusContext,
  type NotificationSettingsSlice,
  type NotificationThreadShellLike,
  type NotificationTrigger,
  type ThreadShellMap,
} from "./notificationSound";

const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");

function makeShell(
  overrides: Partial<NotificationThreadShellLike> = {},
): NotificationThreadShellLike {
  return {
    archivedAt: null,
    latestTurn: null,
    hasPendingApprovals: false,
    hasActionableProposedPlan: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

function shellMap(entries: Array<[ThreadId, NotificationThreadShellLike]>): ThreadShellMap {
  return new Map(entries);
}

function makeSettings(
  overrides: Partial<NotificationSettingsSlice> = {},
): NotificationSettingsSlice {
  return {
    notificationSoundEnabled: true,
    notificationSoundOnTurnEnd: true,
    notificationSoundOnApproval: true,
    notificationSoundOnQuestion: true,
    notificationSoundFocusRule: "always",
    ...overrides,
  };
}

function makeFocus(overrides: Partial<NotificationFocusContext> = {}): NotificationFocusContext {
  return {
    documentVisible: true,
    windowFocused: true,
    currentThreadId: null,
    ...overrides,
  };
}

describe("deriveNotificationTriggers", () => {
  it("fires turn-end on running -> completed", () => {
    const prev = shellMap([[THREAD_A, makeShell({ latestTurn: { state: "running" } })]]);
    const next = shellMap([[THREAD_A, makeShell({ latestTurn: { state: "completed" } })]]);
    expect(deriveNotificationTriggers(prev, next, [])).toEqual<NotificationTrigger[]>([
      { threadId: THREAD_A, kind: "turn-end" },
    ]);
  });

  it("fires turn-end on running -> error", () => {
    const prev = shellMap([[THREAD_A, makeShell({ latestTurn: { state: "running" } })]]);
    const next = shellMap([[THREAD_A, makeShell({ latestTurn: { state: "error" } })]]);
    expect(deriveNotificationTriggers(prev, next, [])).toEqual<NotificationTrigger[]>([
      { threadId: THREAD_A, kind: "turn-end" },
    ]);
  });

  it("fires turn-end on running -> interrupted", () => {
    const prev = shellMap([[THREAD_A, makeShell({ latestTurn: { state: "running" } })]]);
    const next = shellMap([[THREAD_A, makeShell({ latestTurn: { state: "interrupted" } })]]);
    expect(deriveNotificationTriggers(prev, next, [])).toEqual<NotificationTrigger[]>([
      { threadId: THREAD_A, kind: "turn-end" },
    ]);
  });

  it("does not fire turn-end on completed -> completed", () => {
    const prev = shellMap([[THREAD_A, makeShell({ latestTurn: { state: "completed" } })]]);
    const next = shellMap([[THREAD_A, makeShell({ latestTurn: { state: "completed" } })]]);
    expect(deriveNotificationTriggers(prev, next, [])).toEqual([]);
  });

  it("does not fire turn-end when prev is undefined (bootstrap)", () => {
    const prev = shellMap([]);
    const next = shellMap([[THREAD_A, makeShell({ latestTurn: { state: "completed" } })]]);
    expect(deriveNotificationTriggers(prev, next, [])).toEqual([]);
  });

  it("fires approval on hasPendingApprovals false -> true", () => {
    const prev = shellMap([[THREAD_A, makeShell({ hasPendingApprovals: false })]]);
    const next = shellMap([[THREAD_A, makeShell({ hasPendingApprovals: true })]]);
    expect(deriveNotificationTriggers(prev, next, [])).toEqual<NotificationTrigger[]>([
      { threadId: THREAD_A, kind: "approval" },
    ]);
  });

  it("fires approval on hasActionableProposedPlan false -> true", () => {
    const prev = shellMap([[THREAD_A, makeShell({ hasActionableProposedPlan: false })]]);
    const next = shellMap([[THREAD_A, makeShell({ hasActionableProposedPlan: true })]]);
    expect(deriveNotificationTriggers(prev, next, [])).toEqual<NotificationTrigger[]>([
      { threadId: THREAD_A, kind: "approval" },
    ]);
  });

  it("fires approval when both approval and plan rise together", () => {
    const prev = shellMap([
      [THREAD_A, makeShell({ hasPendingApprovals: false, hasActionableProposedPlan: false })],
    ]);
    const next = shellMap([
      [THREAD_A, makeShell({ hasPendingApprovals: true, hasActionableProposedPlan: true })],
    ]);
    expect(deriveNotificationTriggers(prev, next, [])).toEqual<NotificationTrigger[]>([
      { threadId: THREAD_A, kind: "approval" },
    ]);
  });

  it("does not fire approval when transitioning from one approval to another (still pending)", () => {
    const prev = shellMap([
      [THREAD_A, makeShell({ hasPendingApprovals: true, hasActionableProposedPlan: false })],
    ]);
    const next = shellMap([
      [THREAD_A, makeShell({ hasPendingApprovals: true, hasActionableProposedPlan: true })],
    ]);
    expect(deriveNotificationTriggers(prev, next, [])).toEqual([]);
  });

  it("fires question on hasPendingUserInput false -> true", () => {
    const prev = shellMap([[THREAD_A, makeShell({ hasPendingUserInput: false })]]);
    const next = shellMap([[THREAD_A, makeShell({ hasPendingUserInput: true })]]);
    expect(deriveNotificationTriggers(prev, next, [])).toEqual<NotificationTrigger[]>([
      { threadId: THREAD_A, kind: "question" },
    ]);
  });

  it("does not fire question when prev is undefined (bootstrap)", () => {
    const prev = shellMap([]);
    const next = shellMap([[THREAD_A, makeShell({ hasPendingUserInput: true })]]);
    expect(deriveNotificationTriggers(prev, next, [])).toEqual([]);
  });

  it("skips archived threads even on transitions", () => {
    const prev = shellMap([
      [
        THREAD_A,
        makeShell({
          archivedAt: "2026-04-27T00:00:00.000Z",
          latestTurn: { state: "running" },
        }),
      ],
    ]);
    const next = shellMap([
      [
        THREAD_A,
        makeShell({
          archivedAt: "2026-04-27T00:00:00.000Z",
          latestTurn: { state: "completed" },
          hasPendingApprovals: true,
          hasPendingUserInput: true,
        }),
      ],
    ]);
    expect(deriveNotificationTriggers(prev, next, [])).toEqual([]);
  });

  it("emits multiple triggers across threads in one batch", () => {
    const prev = shellMap([
      [THREAD_A, makeShell({ latestTurn: { state: "running" } })],
      [THREAD_B, makeShell({ hasPendingUserInput: false })],
    ]);
    const next = shellMap([
      [THREAD_A, makeShell({ latestTurn: { state: "completed" } })],
      [THREAD_B, makeShell({ hasPendingUserInput: true })],
    ]);
    expect(deriveNotificationTriggers(prev, next, [])).toEqual<NotificationTrigger[]>([
      { threadId: THREAD_A, kind: "turn-end" },
      { threadId: THREAD_B, kind: "question" },
    ]);
  });
});

describe("shouldPlay", () => {
  const triggers: readonly NotificationTrigger[] = [{ threadId: THREAD_A, kind: "turn-end" }];
  // Use a `now` past the throttle window so non-throttle tests are unaffected.
  const NOW = NOTIFICATION_THROTTLE_MS * 10;

  it("returns false when master toggle is off", () => {
    expect(
      shouldPlay(triggers, makeSettings({ notificationSoundEnabled: false }), makeFocus(), NOW, 0),
    ).toBe(false);
  });

  it("returns false when the per-kind toggle is off", () => {
    expect(
      shouldPlay(
        triggers,
        makeSettings({ notificationSoundOnTurnEnd: false }),
        makeFocus(),
        NOW,
        0,
      ),
    ).toBe(false);
  });

  it("returns false when there are no triggers", () => {
    expect(shouldPlay([], makeSettings(), makeFocus(), NOW, 0)).toBe(false);
  });

  describe('focus rule "always"', () => {
    const settings = makeSettings({ notificationSoundFocusRule: "always" });
    it("passes when focused on the same thread", () => {
      expect(
        shouldPlay(
          triggers,
          settings,
          makeFocus({ documentVisible: true, windowFocused: true, currentThreadId: THREAD_A }),
          NOW,
          0,
        ),
      ).toBe(true);
    });
    it("passes when unfocused", () => {
      expect(shouldPlay(triggers, settings, makeFocus({ windowFocused: false }), NOW, 0)).toBe(
        true,
      );
    });
  });

  describe('focus rule "unfocused-only"', () => {
    const settings = makeSettings({ notificationSoundFocusRule: "unfocused-only" });
    it("blocks when focused and visible", () => {
      expect(
        shouldPlay(
          triggers,
          settings,
          makeFocus({ documentVisible: true, windowFocused: true }),
          NOW,
          0,
        ),
      ).toBe(false);
    });
    it("passes when window unfocused", () => {
      expect(shouldPlay(triggers, settings, makeFocus({ windowFocused: false }), NOW, 0)).toBe(
        true,
      );
    });
    it("passes when document hidden", () => {
      expect(shouldPlay(triggers, settings, makeFocus({ documentVisible: false }), NOW, 0)).toBe(
        true,
      );
    });
  });

  describe('focus rule "unfocused-or-different-thread"', () => {
    const settings = makeSettings({ notificationSoundFocusRule: "unfocused-or-different-thread" });
    it("blocks when focused, visible, and on the same thread", () => {
      expect(
        shouldPlay(
          triggers,
          settings,
          makeFocus({
            documentVisible: true,
            windowFocused: true,
            currentThreadId: THREAD_A,
          }),
          NOW,
          0,
        ),
      ).toBe(false);
    });
    it("passes when window unfocused", () => {
      expect(
        shouldPlay(
          triggers,
          settings,
          makeFocus({ windowFocused: false, currentThreadId: THREAD_A }),
          NOW,
          0,
        ),
      ).toBe(true);
    });
    it("passes when document hidden", () => {
      expect(
        shouldPlay(
          triggers,
          settings,
          makeFocus({ documentVisible: false, currentThreadId: THREAD_A }),
          NOW,
          0,
        ),
      ).toBe(true);
    });
    it("passes when viewing a different thread", () => {
      expect(
        shouldPlay(
          triggers,
          settings,
          makeFocus({
            documentVisible: true,
            windowFocused: true,
            currentThreadId: THREAD_B,
          }),
          NOW,
          0,
        ),
      ).toBe(true);
    });
  });

  describe("throttle", () => {
    const settings = makeSettings();
    const focus = makeFocus();
    it("blocks within the throttle window", () => {
      expect(shouldPlay(triggers, settings, focus, NOTIFICATION_THROTTLE_MS - 1, 0)).toBe(false);
    });
    it("passes at exactly the throttle window", () => {
      expect(shouldPlay(triggers, settings, focus, NOTIFICATION_THROTTLE_MS, 0)).toBe(true);
    });
    it("passes after the throttle window", () => {
      expect(shouldPlay(triggers, settings, focus, NOTIFICATION_THROTTLE_MS + 100, 0)).toBe(true);
    });
  });
});
