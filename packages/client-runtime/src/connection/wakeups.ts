import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

export type ConnectionWakeup =
  | "application-active"
  | "application-active-probe"
  | "application-active-reconnect"
  | "credentials-changed"
  // The default network interface changed underneath a socket still bound to
  // the old one. Only a connecting or connected supervisor acts on it, by
  // replacing its lease; the other phases have nothing bound to replace.
  | "network-path-changed";

export function isApplicationActiveWakeup(reason: ConnectionWakeup): boolean {
  return (
    reason === "application-active" ||
    reason === "application-active-probe" ||
    reason === "application-active-reconnect"
  );
}

export function shouldResubscribeAfterWakeup(reason: ConnectionWakeup): boolean {
  return reason === "application-active" || reason === "application-active-probe";
}

export class ConnectionWakeups extends Context.Service<
  ConnectionWakeups,
  {
    readonly changes: Stream.Stream<ConnectionWakeup>;
  }
>()("@t3tools/client-runtime/connection/wakeups/ConnectionWakeups") {}

const make = (service: ConnectionWakeups["Service"]) => ConnectionWakeups.of(service);

export const layer = (service: ConnectionWakeups["Service"]) =>
  Layer.succeed(ConnectionWakeups, make(service));
