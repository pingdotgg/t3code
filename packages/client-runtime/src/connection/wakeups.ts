import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

/** Why a live subscription should re-establish itself.
 *
 *  `resync-requested` is the explicit form: something observed the client's
 *  view disagreeing with the server and asked for the same reconciliation a
 *  foreground wake performs (reload the HTTP snapshot, resume the stream from
 *  its sequence). It exists so a stale view is recoverable in place instead of
 *  only by restarting the client. */
export type ConnectionWakeup = "application-active" | "credentials-changed" | "resync-requested";

/** Wakeups that should re-establish snapshot-backed subscriptions. Credential
 *  changes are excluded: they are handled by the connection supervisor. */
export function wakeupResubscribes(reason: ConnectionWakeup): boolean {
  return reason === "application-active" || reason === "resync-requested";
}

export class ConnectionWakeups extends Context.Service<
  ConnectionWakeups,
  {
    readonly changes: Stream.Stream<ConnectionWakeup>;
  }
>()("@t3tools/client-runtime/connection/wakeups/ConnectionWakeups") {}

export const make = (service: ConnectionWakeups["Service"]) => ConnectionWakeups.of(service);

export const layer = (service: ConnectionWakeups["Service"]) =>
  Layer.succeed(ConnectionWakeups, make(service));
