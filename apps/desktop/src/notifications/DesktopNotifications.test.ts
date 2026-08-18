import {
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type EnvironmentId,
  type NotificationDecidedEdge,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronNotification from "../electron/ElectronNotification.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { NOTIFICATION_TARGET_AVAILABLE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopNotifications from "./DesktopNotifications.ts";

const THREAD_ID = ThreadId.make("thread-1");
const OTHER_THREAD_ID = ThreadId.make("thread-2");
// A real environment id: the server persists a UUID, and the desktop backend
// *instance* id ("primary") is a different namespace entirely.
const ENVIRONMENT_ID = "1b0a0f4e-6f3c-4a91-9f1a-6d6f2b3c4d5e" as EnvironmentId;

function makeEdge(overrides: Partial<NotificationDecidedEdge> = {}): NotificationDecidedEdge {
  const threadId = overrides.threadId ?? THREAD_ID;
  const turnId = overrides.turnId ?? TurnId.make("turn-1");
  return {
    identityKey: `t3:notif:${threadId}:turn-completed:${turnId}`,
    kind: "turn-completed",
    threadId,
    projectId: ProjectId.make("project-1"),
    turnId,
    requestId: null,
    projectTitle: "t3",
    threadTitle: "Fix the flaky test",
    headline: "Turn complete",
    detail: null,
    triggeringEventId: EventId.make("event-1"),
    triggeringSequence: 1,
    previousPhase: "running",
    nextPhase: "completed",
    detectedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Every gate the service consults is a mutable flag rather than a constructor
 * argument, so a test can flip one between two `show` calls — which is the only
 * way to observe gate ordering, or that a suppressed edge stays deliverable.
 */
function makeHarness() {
  const state = {
    focused: false,
    supported: true,
    showFails: false,
  };
  const shown: ElectronNotification.ElectronNotificationShowInput[] = [];
  const closedTitles: string[] = [];
  const dispatchedChannels: string[] = [];
  let resolveFirstDispatch: () => void = () => {};
  const firstDispatch = new Promise<void>((resolve) => {
    resolveFirstDispatch = resolve;
  });

  const notificationLayer = Layer.succeed(ElectronNotification.ElectronNotification, {
    isSupported: Effect.sync(() => state.supported),
    show: (input) =>
      state.showFails
        ? Effect.fail(
            new ElectronNotification.ElectronNotificationShowError({
              titleLength: input.title.length,
              bodyLength: input.body.length,
              cause: new Error("the platform said no"),
            }),
          )
        : Effect.sync(() => {
            shown.push(input);
            return {
              close: Effect.sync(() => {
                closedTitles.push(input.title);
              }),
            };
          }),
  } satisfies ElectronNotification.ElectronNotification["Service"]);

  const windowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected BrowserWindow creation"),
    main: Effect.succeed(Option.none()),
    currentMainOrFirst: Effect.succeed(Option.none()),
    focusedMainOrFirst: Effect.succeed(Option.none()),
    isAnyFocused: Effect.sync(() => state.focused),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  const desktopWindowLayer = Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected createMain"),
    ensureMain: Effect.die("unexpected ensureMain"),
    revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: Effect.void,
    dispatchMenuAction: () => Effect.die("unexpected menu action"),
    zoomMain: () => Effect.die("unexpected zoom"),
    dispatchRendererEvent: (channel) =>
      Effect.sync(() => {
        dispatchedChannels.push(channel);
        resolveFirstDispatch();
      }),
    syncAppearance: Effect.void,
  } satisfies DesktopWindow.DesktopWindow["Service"]);

  const layer = DesktopNotifications.layer.pipe(
    Layer.provide(Layer.mergeAll(notificationLayer, windowLayer, desktopWindowLayer)),
  );

  return { closedTitles, dispatchedChannels, firstDispatch, layer, shown, state };
}

describe("DesktopNotifications", () => {
  it.effect("shows the thread title over the edge's own presentation strings", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const notifications = yield* DesktopNotifications.DesktopNotifications;

      const outcome = yield* notifications.show(makeEdge({ detail: "3 files changed" }));

      assert.strictEqual(outcome, "shown");
      assert.strictEqual(harness.shown.length, 1);
      assert.strictEqual(harness.shown[0]?.title, "Fix the flaky test");
      assert.strictEqual(harness.shown[0]?.body, "Turn complete: t3 — 3 files changed");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("leaves the body unadorned when there is no detail", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const notifications = yield* DesktopNotifications.DesktopNotifications;

      yield* notifications.show(makeEdge());

      assert.strictEqual(harness.shown[0]?.body, "Turn complete: t3");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("suppresses a repeat of an identity it already delivered", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const notifications = yield* DesktopNotifications.DesktopNotifications;

      assert.strictEqual(yield* notifications.show(makeEdge()), "shown");
      assert.strictEqual(yield* notifications.show(makeEdge()), "duplicate");
      assert.strictEqual(harness.shown.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("stays quiet while the setting is off, without burning the edge", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const notifications = yield* DesktopNotifications.DesktopNotifications;
      yield* notifications.setEnabled(false);

      assert.strictEqual(yield* notifications.show(makeEdge()), "suppressed:disabled");
      assert.strictEqual(harness.shown.length, 0);

      // A suppressed edge was never delivered, so the duplicate filter must not
      // have claimed it: turning the setting on has to work on the next edge.
      yield* notifications.setEnabled(true);
      assert.strictEqual(yield* notifications.show(makeEdge()), "shown");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("notifies by default, before the watcher has read the setting", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const notifications = yield* DesktopNotifications.DesktopNotifications;

      assert.strictEqual(yield* notifications.show(makeEdge()), "shown");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("checks for a duplicate before it checks the setting", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const notifications = yield* DesktopNotifications.DesktopNotifications;

      yield* notifications.show(makeEdge());
      yield* notifications.setEnabled(false);

      assert.strictEqual(yield* notifications.show(makeEdge()), "duplicate");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("stays quiet only for the thread the user is already looking at", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const notifications = yield* DesktopNotifications.DesktopNotifications;
      harness.state.focused = true;
      yield* notifications.setWatchedEnvironmentId(ENVIRONMENT_ID);
      yield* notifications.reportActiveThread(
        Option.some({ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID }),
      );

      assert.strictEqual(yield* notifications.show(makeEdge()), "suppressed:focused");
      assert.strictEqual(harness.shown.length, 0);

      // Focused on another thread: "the agent I am not watching finished" is
      // exactly the thing worth saying.
      assert.strictEqual(
        yield* notifications.show(makeEdge({ threadId: OTHER_THREAD_ID })),
        "shown",
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("notifies for the open thread once the app loses focus", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const notifications = yield* DesktopNotifications.DesktopNotifications;
      yield* notifications.reportActiveThread(
        Option.some({ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID }),
      );
      harness.state.focused = false;

      assert.strictEqual(yield* notifications.show(makeEdge()), "shown");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("notifies while focused with no thread open", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const notifications = yield* DesktopNotifications.DesktopNotifications;
      harness.state.focused = true;
      yield* notifications.reportActiveThread(Option.none());

      assert.strictEqual(yield* notifications.show(makeEdge()), "shown");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reports a platform that cannot show notifications at all", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const notifications = yield* DesktopNotifications.DesktopNotifications;
      harness.state.supported = false;

      assert.strictEqual(yield* notifications.show(makeEdge()), "unsupported");
      assert.strictEqual(harness.shown.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not retry an edge whose show attempt threw", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const notifications = yield* DesktopNotifications.DesktopNotifications;
      harness.state.showFails = true;

      assert.strictEqual(yield* notifications.show(makeEdge()), "failed");

      harness.state.showFails = false;
      assert.strictEqual(yield* notifications.show(makeEdge()), "duplicate");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("closes the oldest notification once the cap is exceeded", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const notifications = yield* DesktopNotifications.DesktopNotifications;

      for (let index = 0; index < 26; index += 1) {
        yield* notifications.show(
          makeEdge({
            turnId: TurnId.make(`turn-${index}`),
            threadTitle: `Thread ${index}`,
          }),
        );
      }

      // Two over the cap of 24, and each eviction closed its toast rather than
      // leaving it on screen with no handle to reach it by.
      assert.deepStrictEqual(harness.closedTitles, ["Thread 0", "Thread 1"]);
      assert.strictEqual(harness.shown.length, 26);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("parks a clicked thread and pokes the renderer to come get it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const notifications = yield* DesktopNotifications.DesktopNotifications;
      yield* notifications.setWatchedEnvironmentId(ENVIRONMENT_ID);

      yield* notifications.show(makeEdge());
      assert.isTrue(Option.isNone(yield* notifications.consumePendingTarget));

      harness.shown[0]?.onClick();
      yield* Effect.promise(() => harness.firstDispatch);

      assert.deepStrictEqual(harness.dispatchedChannels, [NOTIFICATION_TARGET_AVAILABLE_CHANNEL]);
      // The environment the server named, not the desktop's backend instance
      // id: a target scoped by "primary" matches no route and opens nothing.
      assert.deepStrictEqual(Option.getOrNull(yield* notifications.consumePendingTarget), {
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
      });
      // Consuming clears it, so a renderer that remounts does not navigate twice.
      assert.isTrue(Option.isNone(yield* notifications.consumePendingTarget));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("parks nothing when a click lands before the environment is known", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const notifications = yield* DesktopNotifications.DesktopNotifications;

      yield* notifications.show(makeEdge());
      harness.shown[0]?.onClick();
      yield* Effect.promise(() => harness.firstDispatch);

      // The window still comes forward; it just has no thread to open.
      assert.deepStrictEqual(harness.dispatchedChannels, [NOTIFICATION_TARGET_AVAILABLE_CHANNEL]);
      assert.isTrue(Option.isNone(yield* notifications.consumePendingTarget));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("notifies for the open thread while the environment is unknown", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const notifications = yield* DesktopNotifications.DesktopNotifications;
      harness.state.focused = true;
      yield* notifications.reportActiveThread(
        Option.some({ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID }),
      );

      assert.strictEqual(yield* notifications.show(makeEdge()), "shown");
    }).pipe(Effect.provide(harness.layer));
  });

  describe("reportableTransportOutcome", () => {
    it("reports the three outcomes the outbox has words for", () => {
      assert.strictEqual(DesktopNotifications.reportableTransportOutcome("shown"), "shown");
      assert.strictEqual(
        DesktopNotifications.reportableTransportOutcome("suppressed:focused"),
        "suppressed:focused",
      );
      assert.strictEqual(
        DesktopNotifications.reportableTransportOutcome("suppressed:disabled"),
        "suppressed:disabled",
      );
    });

    it("keeps transport-local failures out of the audit row", () => {
      // Borrowing a `suppressed:*` value would make the row claim a policy
      // decision nobody made; a duplicate was already reported by the show that
      // claimed the identity key.
      assert.isNull(DesktopNotifications.reportableTransportOutcome("duplicate"));
      assert.isNull(DesktopNotifications.reportableTransportOutcome("unsupported"));
      assert.isNull(DesktopNotifications.reportableTransportOutcome("failed"));
    });
  });
});
