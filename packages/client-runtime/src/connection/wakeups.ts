import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

export type ConnectionWakeup =
  | "application-active"
  | "application-active-probe"
  | "application-active-reconnect"
  | "credentials-changed"
  // The device moved to a different network (another Wi-Fi, Wi-Fi to
  // cellular) while staying online. Saved routes may have changed reach.
  | "network-changed";

function isApplicationActiveWakeup(reason: ConnectionWakeup): boolean {
  return (
    reason === "application-active" ||
    reason === "application-active-probe" ||
    reason === "application-active-reconnect"
  );
}

/** Conditions changed enough that a pending retry should run now, from the first rung. */
export function resetsRetryBackoff(reason: ConnectionWakeup): boolean {
  return isApplicationActiveWakeup(reason) || reason === "network-changed";
}

// A long resume replaces the session, and the new session subscribes on its own.
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
