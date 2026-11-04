import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { requireOptionalNativeModule } from "expo";

export const layerNetworkWake = Layer.sync(ClientCapabilities.NetworkWake, () => {
  const native = requireOptionalNativeModule<{
    wakeOnLan?: (address: string, macAddress: string) => Promise<void>;
  }>("T3NativeControls");
  return {
    send: Effect.fn("mobile.NetworkWake.send")(function* (targets) {
      for (const target of targets) {
        yield* Effect.tryPromise(
          () => native?.wakeOnLan?.(target.address, target.macAddress) ?? Promise.resolve(),
        ).pipe(
          Effect.catch(() =>
            Effect.logWarning(
              "Could not send a local network wake request. Check Local Network permission and the app's multicast entitlement.",
            ),
          ),
        );
      }
    }),
  };
});
