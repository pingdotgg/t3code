import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

export type ConnectionWakeup =
  | "application-active"
  | "application-active-probe"
  | "application-active-long"
  | "application-focused"
  | "credentials-changed"
  | "network-changed";

function isApplicationActiveWakeup(reason: ConnectionWakeup): boolean {
  return (
    reason === "application-active" ||
    reason === "application-active-probe" ||
    reason === "application-active-long"
  );
}

export function resetsRetryBackoff(reason: ConnectionWakeup): boolean {
  return isApplicationActiveWakeup(reason) || reason === "network-changed";
}

export function shouldResubscribeAfterWakeup(reason: ConnectionWakeup): boolean {
  return isApplicationActiveWakeup(reason);
}

// A brief app switch (the mobile probe) does not justify listing the whole account again.
export function shouldRelistAccountAfterWakeup(reason: ConnectionWakeup): boolean {
  return (
    reason === "application-active" ||
    reason === "application-active-long" ||
    reason === "application-focused"
  );
}

// Focus fires on every window switch; any wakeup would arm a running probe's silent-socket check.
export function reachesConnectionSupervisor(reason: ConnectionWakeup): boolean {
  return reason !== "application-focused";
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
