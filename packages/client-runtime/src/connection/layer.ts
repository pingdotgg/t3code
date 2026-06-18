import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { connectionResolverLayer } from "./resolver.ts";
import { connectionDriverLayer } from "./driver.ts";
import { environmentRegistryLayer, EnvironmentRegistry } from "./registry.ts";
import { connectionOnboardingLayer } from "./onboarding.ts";
import { PlatformConnectionSource } from "../platform/source.ts";
import { relayEnvironmentDiscoveryLayer } from "../relay/discovery.ts";
import { remoteEnvironmentAuthorizationLayer } from "../authorization/layer.ts";
import { rpcSessionFactoryLayer } from "../rpc/session.ts";

const resolverLayer = connectionResolverLayer.pipe(
  Layer.provide(remoteEnvironmentAuthorizationLayer),
);

const driverLayer = connectionDriverLayer.pipe(
  Layer.provide(Layer.mergeAll(resolverLayer, rpcSessionFactoryLayer)),
);

const registryLayer = environmentRegistryLayer.pipe(Layer.provide(driverLayer));

const onboardingLayer = connectionOnboardingLayer.pipe(Layer.provide(registryLayer));

const connectionServicesLayer = Layer.mergeAll(
  registryLayer,
  relayEnvironmentDiscoveryLayer,
  onboardingLayer,
);

const connectionStartupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    const platformSource = yield* PlatformConnectionSource;
    yield* registry.start;
    yield* platformSource.registrations.pipe(
      Stream.runForEach(registry.registerPlatform),
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("clientRuntime.connection.application.start")),
);

export const connectionLayer = connectionStartupLayer.pipe(
  Layer.provideMerge(connectionServicesLayer),
);
