import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

export type ConnectionWakeup =
  | "application-active"
  | "application-active-probe"
  | "application-active-long"
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

export class ConnectionWakeups extends Context.Service<
  ConnectionWakeups,
  {
    readonly changes: Stream.Stream<ConnectionWakeup>;
    /** Whether the user is looking at the app now; retries stay frequent while they are. */
    readonly isForeground?: Effect.Effect<boolean>;
    readonly applicationState?: Effect.Effect<"active" | "inactive" | "background" | "unknown">;
  }
>()("@t3tools/client-runtime/connection/wakeups/ConnectionWakeups") {}

const make = (service: ConnectionWakeups["Service"]) => ConnectionWakeups.of(service);

export const layer = (service: ConnectionWakeups["Service"]) =>
  Layer.succeed(ConnectionWakeups, make(service));
