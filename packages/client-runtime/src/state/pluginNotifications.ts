import {
  type EnvironmentId,
  type PluginNotification,
  type PluginNotificationFrame,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { followStreamInEnvironment } from "./runtime.ts";

export interface ReceivedPluginNotification {
  /** Epoch plus sequence: stable across reconnects, distinct across server restarts. */
  readonly key: string;
  readonly notification: PluginNotification;
}

/** The newest notification a renderer has seen from one environment's server. */
export interface PluginNotificationMark {
  readonly epoch: string;
  readonly sequence: number;
}

const notificationKey = (epoch: string, sequence: number) => JSON.stringify([epoch, sequence]);

function supportsPluginNotifications(config: ServerConfig | null): boolean {
  return config?.environment.capabilities.pluginNotifications === true;
}

/**
 * What a renderer does with the latest frame: toast each `show` entry, close
 * every visible toast whose key is not in `keep`, and remember `mark`. That
 * mark and the visible toasts are all a renderer keeps.
 *
 * Without a mark (the first frame a renderer sees, such as on app launch)
 * nothing is shown: what the server already held is history. After that,
 * only notifications above the mark are shown, so a reconnect's frame
 * repeats nothing; a new epoch (the server restarted) shows what it holds.
 * A `null` frame (no supporting server) closes everything and keeps the mark.
 */
export function pluginNotificationChanges(
  mark: PluginNotificationMark | undefined,
  frame: PluginNotificationFrame | null,
): {
  readonly show: ReadonlyArray<ReceivedPluginNotification>;
  readonly keep: ReadonlySet<string>;
  readonly mark: PluginNotificationMark | undefined;
} {
  if (frame === null) return { show: [], keep: new Set(), mark };
  const received = frame.notifications.map((notification) => ({
    key: notificationKey(frame.epoch, notification.sequence),
    notification,
  }));
  const seen = mark === undefined ? Infinity : mark.epoch === frame.epoch ? mark.sequence : 0;
  const newest = Math.max(
    mark?.epoch === frame.epoch ? mark.sequence : 0,
    ...frame.notifications.map((notification) => notification.sequence),
  );
  return {
    show: received.filter((entry) => entry.notification.sequence > seen),
    keep: new Set(received.map((entry) => entry.key)),
    mark: { epoch: frame.epoch, sequence: newest },
  };
}

/** Says who sent it: plugins share the toast surface with the app itself. */
export function pluginNotificationDescription(entry: ReceivedPluginNotification): string {
  const { pluginName, body } = entry.notification;
  return body === undefined ? `From ${pluginName}` : `${body} · ${pluginName}`;
}

/**
 * Follows the environment's sessions and subscribes only on a session whose
 * own server advertises the capability, so an older server never receives the
 * call even while a cached config still says otherwise. Emits each frame, or
 * `null` for a session without the capability. A lost connection keeps the
 * last frame until the next session sends the current one.
 */
const pluginNotificationsStream = Stream.unwrap(
  EnvironmentSupervisor.EnvironmentSupervisor.pipe(
    Effect.map((supervisor) =>
      SubscriptionRef.changes(supervisor.session).pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) =>
              Stream.unwrap(
                session.initialConfig.pipe(
                  Effect.map((config): Stream.Stream<PluginNotificationFrame | null> =>
                    supportsPluginNotifications(config)
                      ? session.client[WS_METHODS.pluginsNotificationsSubscribe]({}).pipe(
                          Stream.catchCause((cause) =>
                            Stream.fromEffect(
                              Effect.logWarning(
                                "Plugin notifications stopped; waiting for the next session.",
                                { cause: Cause.pretty(cause) },
                              ),
                            ).pipe(Stream.drain),
                          ),
                        )
                      : Stream.succeed(null),
                  ),
                  // A session that never delivered its config subscribes to nothing.
                  Effect.orElseSucceed(() => Stream.empty),
                ),
              ),
          }),
        ),
      ),
    ),
  ),
);

/**
 * The latest plugin notification frame per environment, for toasts on web
 * and mobile; `null` when the environment's server lacks the capability.
 */
export function createPluginNotificationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: {
    readonly configValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
  },
) {
  const subscription = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(followStreamInEnvironment(environmentId, pluginNotificationsStream), {
        initialValue: null,
      })
      .pipe(Atom.withLabel(`environment-data:plugin-notifications:subscription:${environmentId}`)),
  );
  const frame = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): PluginNotificationFrame | null => {
      if (!supportsPluginNotifications(get(options.configValueAtom(environmentId)))) return null;
      return Option.getOrNull(AsyncResult.value(get(subscription(environmentId))));
    }).pipe(Atom.withLabel(`environment-data:plugin-notifications:frame:${environmentId}`)),
  );
  return { frame };
}
