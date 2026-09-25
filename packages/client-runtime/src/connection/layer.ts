import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";

import * as ConnectionResolver from "./resolver.ts";
import * as ConnectionDriver from "./driver.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionOnboarding from "./onboarding.ts";
import * as PlatformConnectionSource from "../platform/source.ts";
import * as RelayEnvironmentDiscovery from "../relay/discovery.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as RpcSession from "../rpc/session.ts";

export const watchDiscoveredCompatibility = Effect.fn("connection.watchDiscoveredCompatibility")(
  function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
    const seenChecks = new Map<string, RelayEnvironmentStatusResponse>();
    yield* Stream.merge(
      SubscriptionRef.changes(discovery.state),
      SubscriptionRef.changes(registry.entries),
    ).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(discovery.state);
          if (!current.refreshing) {
            for (const environmentId of seenChecks.keys()) {
              if (!current.environments.has(environmentId)) seenChecks.delete(environmentId);
            }
          }
          const saved = yield* SubscriptionRef.get(registry.entries);
          for (const entry of current.environments.values()) {
            const environmentId = entry.environment.environmentId;
            const target = saved.get(environmentId)?.target;
            if (
              target?._tag === "RelayConnectionTarget" &&
              (target.label !== entry.environment.label || target.localLabelOverride === true)
            ) {
              yield* registry.syncRelayLabel(environmentId, entry.environment.label).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Could not sync discovered environment label.", {
                    environmentId,
                    operation: error.operation,
                  }),
                ),
              );
            }
            const status = Option.getOrNull(entry.status);
            const descriptor = status?.descriptor;
            if (status === null || descriptor === undefined) continue;
            const previous = seenChecks.get(environmentId);
            const fresh =
              previous?.checkedAt !== status.checkedAt ||
              (previous.descriptor?.orchestrationProtocolVersion ?? 1) !==
                (descriptor.orchestrationProtocolVersion ?? 1) ||
              previous.descriptor?.serverVersion !== descriptor.serverVersion;
            const error = orchestrationProtocolCompatibilityError(descriptor);
            // A replayed health result must not clear a newer socket rejection.
            if (error !== null || fresh) yield* registry.setCompatibility(environmentId, error);
            seenChecks.set(environmentId, status);
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not apply discovered environment compatibility.", { error }),
          ),
        ),
      ),
    );
  },
);

export function layerWithOptions(options: RpcSession.RpcSessionOptions) {
  const driverLayer = ConnectionDriver.layer.pipe(
    Layer.provide(Layer.mergeAll(ConnectionResolver.layer, RpcSession.layerWithOptions(options))),
  );
  const registryLayer = EnvironmentRegistry.layer.pipe(Layer.provide(driverLayer));
  const onboardingLayer = ConnectionOnboarding.layer.pipe(Layer.provide(registryLayer));
  const connectionServicesLayer = Layer.mergeAll(
    registryLayer,
    RelayEnvironmentDiscovery.layer,
    onboardingLayer,
  );
  const connectionStartupLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const platformSource = yield* PlatformConnectionSource.PlatformConnectionSource;
      yield* watchDiscoveredCompatibility().pipe(Effect.forkScoped);
      yield* registry.start;
      yield* platformSource.registrations.pipe(
        Stream.runForEach(registry.reconcilePlatform),
        Effect.forkScoped,
      );
    }).pipe(Effect.withSpan("clientRuntime.connection.application.start")),
  );
  return connectionStartupLayer.pipe(
    Layer.provideMerge(connectionServicesLayer),
    Layer.provideMerge(RemoteEnvironmentAuthorization.layer),
  );
}

export const layer = layerWithOptions({});
