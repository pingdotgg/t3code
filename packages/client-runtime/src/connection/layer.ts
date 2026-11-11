import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ConnectionResolver from "./resolver.ts";
import * as ConnectionDriver from "./driver.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionOnboarding from "./onboarding.ts";
import * as PlatformConnectionSource from "../platform/source.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as RpcSession from "../rpc/session.ts";

export function layerWithOptions(options: RpcSession.RpcSessionOptions) {
  const layerDriver = ConnectionDriver.layer.pipe(
    Layer.provide(Layer.mergeAll(ConnectionResolver.layer, RpcSession.layer(options))),
  );
  const layerRegistry = EnvironmentRegistry.layer.pipe(Layer.provide(layerDriver));
  const layerOnboarding = ConnectionOnboarding.layer.pipe(Layer.provide(layerRegistry));
  const layerConnectionServices = Layer.mergeAll(
    layerRegistry,
    layerOnboarding,
    ConnectionResolver.layer,
  );
  const layerConnectionStartup = Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const platformSource = yield* PlatformConnectionSource.PlatformConnectionSource;
      yield* registry.start;
      yield* platformSource.registrations.pipe(
        Stream.runForEach(registry.reconcilePlatform),
        Effect.forkScoped,
      );
    }).pipe(Effect.withSpan("clientRuntime.connection.application.start")),
  );
  return layerConnectionStartup.pipe(
    Layer.provideMerge(layerConnectionServices),
    Layer.provideMerge(RemoteEnvironmentAuthorization.layer),
  );
}

export const layer = layerWithOptions({});
