import type { NotificationDecidedEdge, ScopedThreadRef } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  decideNotificationToast,
  notificationToastContent,
  notificationToastType,
  shouldSuppressToastForFocus,
} from "./notificationToast.logic";

const ENVIRONMENT_ID = "primary";

const EDGE = {
  identityKey: "t3:notif:thread-1:turn-completed:turn-9",
  kind: "turn-completed",
  threadId: "thread-1",
  projectId: "project-1",
  turnId: "turn-9",
  requestId: null,
  projectTitle: "t3",
  threadTitle: "Wire the toasts",
  headline: "Turn finished",
  detail: null,
  triggeringEventId: "event-1",
  triggeringSequence: 42,
  previousPhase: "running",
  nextPhase: "completed",
  detectedAt: "2026-08-06T10:00:00.000Z",
} as unknown as NotificationDecidedEdge;

const THREAD_REF = {
  environmentId: ENVIRONMENT_ID,
  threadId: "thread-1",
} as unknown as ScopedThreadRef;

const OTHER_THREAD_REF = {
  environmentId: ENVIRONMENT_ID,
  threadId: "thread-2",
} as unknown as ScopedThreadRef;

const ON_SCREEN = {
  edge: EDGE,
  environmentId: ENVIRONMENT_ID,
  notificationsEnabled: true,
  appFocused: true,
  activeThreadRef: THREAD_REF,
  alreadyHandled: false,
} as const;

describe("decideNotificationToast", () => {
  it("suppresses the edge for the thread on screen in a focused tab", () => {
    assert.deepStrictEqual(decideNotificationToast(ON_SCREEN), {
      action: "suppress",
      outcome: "suppressed:focused",
    });
  });

  it("shows an edge for a different thread even while focused", () => {
    assert.deepStrictEqual(
      decideNotificationToast({ ...ON_SCREEN, activeThreadRef: OTHER_THREAD_REF }),
      { action: "show", outcome: "shown" },
    );
  });

  it("shows an edge for the open thread when the tab is not focused", () => {
    assert.deepStrictEqual(decideNotificationToast({ ...ON_SCREEN, appFocused: false }), {
      action: "show",
      outcome: "shown",
    });
  });

  it("shows an edge when no thread is open", () => {
    assert.deepStrictEqual(decideNotificationToast({ ...ON_SCREEN, activeThreadRef: null }), {
      action: "show",
      outcome: "shown",
    });
  });

  it("reports the disabled setting as a suppression rather than skipping silently", () => {
    assert.deepStrictEqual(
      decideNotificationToast({
        ...ON_SCREEN,
        activeThreadRef: OTHER_THREAD_REF,
        notificationsEnabled: false,
      }),
      { action: "suppress", outcome: "suppressed:disabled" },
    );
  });

  it("lets the setting win over the focus rule so the outcome names the real reason", () => {
    assert.deepStrictEqual(decideNotificationToast({ ...ON_SCREEN, notificationsEnabled: false }), {
      action: "suppress",
      outcome: "suppressed:disabled",
    });
  });

  it("skips an already handled identity key without reporting again", () => {
    assert.deepStrictEqual(
      decideNotificationToast({
        ...ON_SCREEN,
        activeThreadRef: OTHER_THREAD_REF,
        alreadyHandled: true,
      }),
      { action: "skip", reason: "duplicate" },
    );
  });
});

describe("shouldSuppressToastForFocus", () => {
  it("does not treat the same thread id in another environment as on screen", () => {
    assert.isFalse(
      shouldSuppressToastForFocus({
        appFocused: true,
        activeThreadRef: {
          environmentId: "secondary",
          threadId: "thread-1",
        } as unknown as ScopedThreadRef,
        environmentId: ENVIRONMENT_ID,
        edge: EDGE,
      }),
    );
  });
});

describe("notificationToastType", () => {
  it("maps each kind to its severity", () => {
    assert.strictEqual(notificationToastType("turn-completed"), "success");
    assert.strictEqual(notificationToastType("turn-failed"), "error");
    assert.strictEqual(notificationToastType("approval-required"), "warning");
    assert.strictEqual(notificationToastType("user-input-required"), "warning");
  });
});

describe("notificationToastContent", () => {
  it("renders the edge's own strings without re-deriving copy", () => {
    assert.deepStrictEqual(notificationToastContent(EDGE), {
      title: "Turn finished",
      description: "t3 · Wire the toasts",
    });
  });

  it("appends the detail when the reactor supplied one", () => {
    assert.deepStrictEqual(
      notificationToastContent({ ...EDGE, detail: "3 files changed" } as NotificationDecidedEdge),
      {
        title: "Turn finished",
        description: "t3 · Wire the toasts — 3 files changed",
      },
    );
  });
});
