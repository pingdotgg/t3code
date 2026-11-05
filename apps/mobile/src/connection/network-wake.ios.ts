import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { requireOptionalNativeModule } from "expo";

class NetworkWakeError extends Schema.TaggedError<NetworkWakeError>()("NetworkWakeError", {
  cause: Schema.Defect(),
}) {}

export const layerNetworkWake = Layer.sync(ClientCapabilities.NetworkWake, () => {
  const native = requireOptionalNativeModule<{
    wakeOnLan?: (address: string, macAddress: string) => Promise<void>;
  }>("T3NativeControls");
  return {
    send: Effect.fn("mobile.NetworkWake.send")(function* (targets) {
      for (const target of targets) {
        yield* Effect.tryPromise({
          try: () => native?.wakeOnLan?.(target.address, target.macAddress) ?? Promise.resolve(),
          catch: (cause) => new NetworkWakeError({ cause }),
        }).pipe(
          Effect.catchTags({
            NetworkWakeError: () =>
              Effect.logWarning(
                "Could not send a local network wake request. Check Local Network permission and the app's multicast entitlement.",
              ),
          }),
        );
      }
    }),
  };
});
