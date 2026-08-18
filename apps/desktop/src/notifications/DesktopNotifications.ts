/**
 * Presents native notifications and remembers where a clicked one wants to go.
 *
 * Whether a notification-worthy thing happened was already decided server-side
 * by the `NotificationReactor`; this service only answers "should this decided
 * edge reach the OS right now, and what happens when the user clicks it".
 * Presentation strings travel with the edge — nothing here re-derives copy.
 *
 * Click routing is deliberately signal-then-pull. Main parks the clicked
 * thread, then pokes the renderer over a payload-free channel; the renderer
 * pulls the target back when it is ready. That survives a click that arrives
 * before the window exists — a cold start, or a window recreated after close —
 * which a plain "send the payload to the renderer" push would drop on the floor.
 */
import {
  type DesktopNotificationTarget,
  type EnvironmentId,
  type NotificationDecidedEdge,
  type NotificationReportedTransportOutcome,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronNotification from "../electron/ElectronNotification.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { NOTIFICATION_TARGET_AVAILABLE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

/**
 * How many delivered notifications stay reachable. Electron drops a
 * garbage-collected `Notification` out of the OS notification centre, so live
 * ones must be held; the cap keeps a long session from retaining every toast it
 * ever showed.
 */
const MAX_ACTIVE_NOTIFICATIONS = 24;

/**
 * How many identity keys the duplicate filter remembers. Sized well above the
 * number of threads a single environment realistically has in flight, so a
 * re-sent edge is still recognised after a burst of unrelated activity.
 */
const MAX_HANDLED_EDGES = 512;

const { logInfo: logNotificationInfo, logWarning: logNotificationWarning } =
  makeComponentLogger("desktop-notifications");

/**
 * What this transport did with an edge.
 *
 * The first three map onto the server's reportable outcomes. The last three are
 * transport-local truths the server vocabulary has no honest word for, so they
 * are recorded here and logged rather than misreported as policy suppression —
 * see `reportableTransportOutcome`.
 */
export type DesktopNotificationDeliveryOutcome =
  | "shown"
  | "suppressed:disabled"
  | "suppressed:focused"
  | "duplicate"
  | "unsupported"
  | "failed";

export class DesktopNotifications extends Context.Service<
  DesktopNotifications,
  {
    /**
     * Presents `edge`, or explains why it was suppressed. Suppression is a
     * normal outcome, never a failure: the caller is a background subscription
     * that must not care whether the platform cooperated.
     */
    readonly show: (
      edge: NotificationDecidedEdge,
    ) => Effect.Effect<DesktopNotificationDeliveryOutcome>;
    /** Reads and clears the thread a clicked notification asked for. */
    readonly consumePendingTarget: Effect.Effect<Option.Option<DesktopNotificationTarget>>;
    /** Records the thread the renderer currently has open, for the focus rule. */
    readonly reportActiveThread: (
      target: Option.Option<DesktopNotificationTarget>,
    ) => Effect.Effect<void>;
    /** Records the server-authoritative global on/off setting. */
    readonly setEnabled: (enabled: boolean) => Effect.Effect<void>;
    /**
     * Records the environment id of the backend being watched. Main knows the
     * backend by its *instance* id ("primary"); routes and the renderer's
     * active-thread reports are scoped by the *environment* id the server
     * persists, and only the server can say what that is.
     */
    readonly setWatchedEnvironmentId: (environmentId: EnvironmentId) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/notifications/DesktopNotifications") {}

export type DesktopNotificationsServices =
  | ElectronNotification.ElectronNotification
  | ElectronWindow.ElectronWindow
  | DesktopWindow.DesktopWindow;

/**
 * The body reads "<headline>: <project>" under a "<thread>" title. Every string
 * comes from the decided edge verbatim — one wording change lands in one place,
 * and two transports can never disagree about what a turn was called.
 */
export function notificationBody(edge: NotificationDecidedEdge): string {
  const suffix = edge.detail === null ? "" : ` — ${edge.detail}`;
  return `${edge.headline}: ${edge.projectTitle}${suffix}`;
}

/**
 * Suppress only when *that* thread is on screen. An app focused on a different
 * thread still notifies: "the agent I am not looking at finished" is exactly the
 * thing worth saying.
 */
export function shouldSuppressForFocus(input: {
  readonly appFocused: boolean;
  readonly activeThread: Option.Option<DesktopNotificationTarget>;
  readonly watchedEnvironmentId: Option.Option<EnvironmentId>;
  readonly edge: NotificationDecidedEdge;
}): boolean {
  if (!input.appFocused) return false;
  if (Option.isNone(input.watchedEnvironmentId)) return false;
  const watchedEnvironmentId = input.watchedEnvironmentId.value;
  return Option.match(input.activeThread, {
    onNone: () => false,
    onSome: (active) =>
      active.threadId === input.edge.threadId && active.environmentId === watchedEnvironmentId,
  });
}

/**
 * Which outcomes are worth reporting back to the outbox.
 *
 * `duplicate` was already reported under the same identity key by the show that
 * claimed it. `unsupported` and `failed` are platform facts, not policy: the
 * server enum has no value for them, and borrowing `suppressed:*` would make the
 * audit row claim a decision nobody made. The row stays uncompleted instead,
 * which is at least true.
 */
export function reportableTransportOutcome(
  outcome: DesktopNotificationDeliveryOutcome,
): NotificationReportedTransportOutcome | null {
  switch (outcome) {
    case "shown":
    case "suppressed:disabled":
    case "suppressed:focused":
      return outcome;
    default:
      return null;
  }
}

/**
 * Closes and forgets the oldest notifications once the cap is exceeded.
 * Closing matters: dropping the map entry alone leaves the toast on screen
 * until the OS expires it, and leaks the renderer-side object with it.
 */
function pruneActive(active: Map<string, ElectronNotification.ElectronNotificationHandle>): void {
  while (active.size > MAX_ACTIVE_NOTIFICATIONS) {
    const oldest = active.entries().next();
    if (oldest.done === true) return;
    const [identityKey, handle] = oldest.value;
    active.delete(identityKey);
    Effect.runSync(handle.close);
  }
}

function pruneHandled(handled: Set<string>): void {
  while (handled.size > MAX_HANDLED_EDGES) {
    const oldest = handled.values().next();
    if (oldest.done === true) return;
    handled.delete(oldest.value);
  }
}

export const make = Effect.gen(function* () {
  const electronNotification = yield* ElectronNotification.ElectronNotification;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const context = yield* Effect.context<DesktopNotificationsServices>();
  const runPromise = Effect.runPromiseWith(context);

  const pendingTargetRef = yield* Ref.make<Option.Option<DesktopNotificationTarget>>(Option.none());
  const activeThreadRef = yield* Ref.make<Option.Option<DesktopNotificationTarget>>(Option.none());
  // Default ON, matching the server default: the watcher pushes the real value
  // as soon as it has read the config, and until then silence would be a worse
  // failure than one notification too many.
  const enabledRef = yield* Ref.make(true);
  // Empty until the watcher has read the backend's descriptor; it does that
  // before it subscribes, so an edge never arrives without it.
  const watchedEnvironmentIdRef = yield* Ref.make<Option.Option<EnvironmentId>>(Option.none());
  // Insertion-ordered, which is what makes "evict the oldest" a `next()` away.
  const active = new Map<string, ElectronNotification.ElectronNotificationHandle>();
  const handled = new Set<string>();

  const handleClick = Effect.fn("desktop.notifications.handleClick")(function* (
    edge: NotificationDecidedEdge,
  ) {
    const watchedEnvironmentId = yield* Ref.get(watchedEnvironmentIdRef);
    if (Option.isNone(watchedEnvironmentId)) {
      // Nothing to navigate to, but the click still means "show me the app".
      yield* logNotificationWarning("clicked a notification with no known environment", {
        kind: edge.kind,
      });
    } else {
      yield* Ref.set(
        pendingTargetRef,
        Option.some({ environmentId: watchedEnvironmentId.value, threadId: edge.threadId }),
      );
    }
    yield* desktopWindow.dispatchRendererEvent(NOTIFICATION_TARGET_AVAILABLE_CHANNEL).pipe(
      Effect.catch((error) =>
        logNotificationWarning("could not route a notification click", {
          message: error.message,
        }),
      ),
    );
  });

  return DesktopNotifications.of({
    show: Effect.fn("desktop.notifications.show")(function* (edge) {
      yield* Effect.annotateCurrentSpan({ kind: edge.kind, identityKey: edge.identityKey });

      if (handled.has(edge.identityKey)) return "duplicate" as const;

      if (!(yield* Ref.get(enabledRef))) return "suppressed:disabled" as const;

      if (
        shouldSuppressForFocus({
          appFocused: yield* electronWindow.isAnyFocused,
          activeThread: yield* Ref.get(activeThreadRef),
          watchedEnvironmentId: yield* Ref.get(watchedEnvironmentIdRef),
          edge,
        })
      ) {
        return "suppressed:focused" as const;
      }

      if (!(yield* electronNotification.isSupported)) return "unsupported" as const;

      // Recorded before the show attempt: a platform that fails once will fail
      // again for the same edge, and retrying it on the next tick would turn
      // one broken notification into a loop.
      handled.add(edge.identityKey);
      pruneHandled(handled);

      const handle = yield* electronNotification
        .show({
          title: edge.threadTitle,
          body: notificationBody(edge),
          onClick: () => {
            void runPromise(handleClick(edge));
          },
        })
        .pipe(Effect.option);
      if (Option.isNone(handle)) {
        yield* logNotificationWarning("could not show a notification", { kind: edge.kind });
        return "failed" as const;
      }

      active.set(edge.identityKey, handle.value);
      pruneActive(active);
      yield* logNotificationInfo("notification shown", { kind: edge.kind });
      return "shown" as const;
    }),
    consumePendingTarget: Ref.getAndSet(pendingTargetRef, Option.none()).pipe(
      Effect.withSpan("desktop.notifications.consumePendingTarget"),
    ),
    reportActiveThread: (target) => Ref.set(activeThreadRef, target),
    setEnabled: (enabled) => Ref.set(enabledRef, enabled),
    setWatchedEnvironmentId: (environmentId) =>
      Ref.set(watchedEnvironmentIdRef, Option.some(environmentId)),
  });
});

export const layer = Layer.effect(DesktopNotifications, make);
