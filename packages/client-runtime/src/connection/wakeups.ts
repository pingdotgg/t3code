import * as Context from "effect/Context";
import type * as Stream from "effect/Stream";

export type ConnectionWakeup = "application-active" | "credentials-changed";

export class ConnectionWakeups extends Context.Service<
  ConnectionWakeups,
  {
    readonly changes: Stream.Stream<ConnectionWakeup>;
  }
>()("@t3tools/client-runtime/connection/wakeups/ConnectionWakeups") {}
