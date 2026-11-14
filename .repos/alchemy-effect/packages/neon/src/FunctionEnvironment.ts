import * as Context from "effect/Context";

/** Environment injected into a Neon Function process; never contains the deployment account API key. */
export class FunctionEnvironment extends Context.Service<
  FunctionEnvironment,
  Readonly<Record<string, string | undefined>>
>()("Neon.FunctionEnvironment") {}

/** Native request retained for WebSocket upgrades and Fetch interoperability. */
export class FunctionRequest extends Context.Service<FunctionRequest, Request>()(
  "Neon.FunctionRequest",
) {}
