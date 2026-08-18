/**
 * Subscribes the main process to the server's decided-edge stream.
 *
 * The renderer's subscription only exists while a window does. Closing the last
 * window — the normal way to get an agent out of the way while it works — is
 * exactly when a notification matters most, and is exactly when that
 * subscription is gone. So main opens its own WebSocket to the backend it
 * already spawned.
 *
 * Only the *primary local* environment. Remote environments are held by the
 * renderer, which owns their credentials; main has no way to dial them and no
 * business learning how. Local is also the only case where "the window is closed
 * but the agent is still working" is even possible.
 *
 * The connection is deliberately unconditional rather than gated on the
 * notification setting: a socket that opens and closes with a toggle would miss
 * the edges detected during the gap, and the per-edge check in
 * `DesktopNotifications.show` is where the decision belongs anyway. The same
 * socket carries the config subscription that keeps that setting current.
 */
import { resolveRemoteWebSocketConnectionUrl } from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { makeWsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import {
  NOTIFICATION_WS_METHODS,
  WS_METHODS,
  type NotificationDecidedEdge,
  type NotificationStreamItem,
  type ServerConfigStreamEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopNotifications from "./DesktopNotifications.ts";

/** How long to wait for the primary backend before retrying the whole attempt. */
const BACKEND_READY_TIMEOUT = Duration.seconds(30);

/**
 * Reconnect delay. Flat rather than exponential because the expensive failure
 * mode already backs itself off: when the backend is down, every attempt spends
 * `BACKEND_READY_TIMEOUT` waiting for it. This delay only paces the cheap
 * failures — a restart or a dropped socket — where retrying soon is the point.
 */
const RECONNECT_DELAY = Duration.seconds(2);

const { logInfo: logWatcherInfo, logWarning: logWatcherWarning } = makeComponentLogger(
  "desktop-notification-watcher",
);

class DesktopNotificationWatcherUnavailableError extends Schema.TaggedErrorClass<DesktopNotificationWatcherUnavailableError>()(
  "DesktopNotificationWatcherUnavailableError",
  { reason: Schema.Literals(["not-configured", "not-ready"]) },
) {
  override get message(): string {
    return this.reason === "not-configured"
      ? "The primary local backend has no resolved configuration yet."
      : "The primary local backend did not become ready in time.";
  }
}

export class DesktopNotificationWatcher extends Context.Service<
  DesktopNotificationWatcher,
  {
    /**
     * Runs until interrupted, reconnecting on its own. Fork it; it never fails,
     * because a watcher that gave up would silently stop notifying.
     */
    readonly run: Effect.Effect<never>;
  }
>()("@t3tools/desktop/notifications/DesktopNotificationWatcher") {}

export type DesktopNotificationWatcherServices =
  | DesktopBackendPool.DesktopBackendPool
  | DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth
  | DesktopNotifications.DesktopNotifications
  | HttpClient.HttpClient
  | Socket.WebSocketConstructor;

function toWebSocketBaseUrl(httpBaseUrl: URL): string {
  const url = new URL(httpBaseUrl.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/**
 * Shows every edge on `items` and reports back what happened to it.
 *
 * Split out from the connect path because this is the whole behaviour worth
 * testing, and the connect path is a socket. `resumeSequenceRef` lives for the
 * process, not the subscription: it is how a reconnect closes its own gap
 * without turning a fresh launch into a replay of history.
 */
export const deliverNotificationStream = Effect.fn(
  "desktop.notificationWatcher.deliverNotificationStream",
)(function* <E, R>(options: {
  readonly items: Stream.Stream<NotificationStreamItem, E, R>;
  readonly show: (
    edge: NotificationDecidedEdge,
  ) => Effect.Effect<DesktopNotifications.DesktopNotificationDeliveryOutcome>;
  readonly report: (input: {
    readonly identityKey: string;
    readonly outcome: Exclude<
      ReturnType<typeof DesktopNotifications.reportableTransportOutcome>,
      null
    >;
  }) => Effect.Effect<void>;
  readonly resumeSequenceRef: Ref.Ref<Option.Option<number>>;
}) {
  yield* Stream.runForEach(options.items, (item) =>
    Effect.gen(function* () {
      if (item.kind !== "edge") return;
      const edge = item.edge;
      const outcome = yield* options.show(edge);
      // Recorded for every edge the transport handled, shown or not: the server
      // dedupes a resumed range by identity, so remembering a suppressed edge is
      // what keeps a reconnect from re-deciding it.
      yield* Ref.update(options.resumeSequenceRef, (current) =>
        Option.some(
          Option.match(current, {
            onNone: () => edge.triggeringSequence,
            onSome: (previous) => Math.max(previous, edge.triggeringSequence),
          }),
        ),
      );
      const reportable = DesktopNotifications.reportableTransportOutcome(outcome);
      if (reportable === null) {
        yield* logWatcherInfo("notification not delivered", {
          kind: edge.kind,
          outcome,
        });
        return;
      }
      yield* options.report({ identityKey: edge.identityKey, outcome: reportable });
    }),
  );
});

export const make = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const localAuth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
  const notifications = yield* DesktopNotifications.DesktopNotifications;
  const httpClient = yield* HttpClient.HttpClient;
  const webSocketConstructor = yield* Socket.WebSocketConstructor;

  // Deliberately outside `connect`: a reconnect resumes from it, a fresh launch
  // starts with `none` and therefore receives no catch-up at all.
  const resumeSequenceRef = yield* Ref.make(Option.none<number>());

  const connect = Effect.fn("desktop.notificationWatcher.connect")(function* () {
    const primary = yield* pool.primary;
    if (!(yield* primary.waitForReady(BACKEND_READY_TIMEOUT))) {
      return yield* new DesktopNotificationWatcherUnavailableError({ reason: "not-ready" });
    }
    const config = yield* primary.currentConfig;
    if (Option.isNone(config)) {
      return yield* new DesktopNotificationWatcherUnavailableError({ reason: "not-configured" });
    }

    const httpBaseUrl = config.value.httpBaseUrl;
    // Main knows this backend as the "primary" *instance*; a thread route is
    // scoped by the *environment* id the server persists, which only the server
    // can name. Read it before subscribing so no edge can be clicked without it.
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: httpBaseUrl.href,
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    yield* notifications.setWatchedEnvironmentId(descriptor.environmentId);

    const bearerToken = yield* localAuth.getBearerToken;
    const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
      wsBaseUrl: toWebSocketBaseUrl(httpBaseUrl),
      httpBaseUrl: httpBaseUrl.href,
      bearerToken,
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      // The watcher's own reconnect loop owns retries: letting the protocol
      // retry underneath would reconnect without re-issuing the WebSocket
      // ticket, which is single-use.
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Socket.layerWebSocket(socketUrl).pipe(
            Layer.provide(Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor)),
          ),
          RpcSerialization.layerJson,
        ),
      ),
    );

    const client = yield* makeWsRpcProtocolClient.pipe(
      Effect.provide(yield* Layer.build(protocolLayer)),
    );

    // The one knob is a server setting, so main has no local copy to read; this
    // stream is both the initial read and the change feed.
    const trackSetting = Stream.runForEach(
      client[WS_METHODS.subscribeServerConfig]({}),
      (event: ServerConfigStreamEvent) => {
        if (event.type === "snapshot") {
          return notifications.setEnabled(event.config.settings.notificationsEnabled);
        }
        if (event.type === "settingsUpdated") {
          return notifications.setEnabled(event.payload.settings.notificationsEnabled);
        }
        return Effect.void;
      },
    );

    const resumeSequence = yield* Ref.get(resumeSequenceRef);
    yield* logWatcherInfo("watching for notifications", {
      resuming: Option.isSome(resumeSequence),
    });

    yield* Effect.all(
      [
        trackSetting,
        deliverNotificationStream({
          items: client[NOTIFICATION_WS_METHODS.subscribe](
            Option.match(resumeSequence, {
              onNone: () => ({}),
              onSome: (afterSequence) => ({ afterSequence }),
            }),
          ),
          show: (edge) => notifications.show(edge),
          report: ({ identityKey, outcome }) =>
            client[NOTIFICATION_WS_METHODS.reportTransportOutcome]({
              identityKey,
              transportName: "desktop",
              outcome,
            }).pipe(
              Effect.asVoid,
              // A row that never got completed is an audit gap, not a reason to
              // drop the subscription that is still delivering notifications.
              Effect.catchCause((cause) =>
                logWatcherWarning("could not report a notification outcome", {
                  identityKey,
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
          resumeSequenceRef,
        }),
      ],
      { concurrency: 2 },
    );
  });

  const attempt = Effect.scoped(connect()).pipe(
    // A dropped subscription is a normal outcome (backend restart, sleep/wake),
    // not something to escalate — the loop below just tries again.
    Effect.catchCause((cause) =>
      logWatcherWarning("lost the notification subscription", { cause: Cause.pretty(cause) }),
    ),
  );

  const run = attempt.pipe(
    Effect.repeat(Schedule.spaced(RECONNECT_DELAY)),
    // `repeat` on a forever-schedule is already non-terminating; this only
    // proves that to the type system so callers can fork it as `Effect<never>`.
    Effect.andThen(Effect.never),
    Effect.withSpan("desktop.notificationWatcher.run"),
  );

  return DesktopNotificationWatcher.of({ run });
});

export const layer = Layer.effect(DesktopNotificationWatcher, make);
