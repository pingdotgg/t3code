import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const layerNetworkWake = Layer.succeed(ClientCapabilities.NetworkWake, {
  send: Effect.fn("mobile.NetworkWake.send")(() => Effect.void),
});
