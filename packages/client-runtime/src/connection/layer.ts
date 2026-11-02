import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Connectivity from "./connectivity.ts";
import * as Wakeups from "./wakeups.ts";
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
import { connectionRoutes, hasRelayRoute } from "./routes.ts";
import * as PlatformConnectionSource from "../platform/source.ts";
import * as RelayEnvironmentDiscovery from "../relay/discovery.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as RpcSession from "../rpc/session.ts";

const isEnvironmentId = Schema.is(EnvironmentId);

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
          const registered = yield* SubscriptionRef.get(registry.entries);
          for (const entry of current.environments.values()) {
            const status = Option.getOrNull(entry.status);
            const descriptor = status?.descriptor;
            if (status === null || descriptor === undefined) continue;
            const environmentId = entry.environment.environmentId;
            // Discovery describes the server behind the relay route. A direct
            // connection (the desktop's own server, a saved URL, SSH) can reach
            // a different server with the same environment id, such as a
            // preview app that shares the home directory.
            const saved = registered.get(environmentId);
            if (
              saved === undefined ||
              connectionRoutes(saved).length !== 1 ||
              !hasRelayRoute(saved)
            )
              continue;
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
  const layerDriver = ConnectionDriver.layer.pipe(
    Layer.provide(Layer.mergeAll(ConnectionResolver.layer, RpcSession.layer(options))),
  );
  const layerRegistry = EnvironmentRegistry.layer.pipe(Layer.provide(layerDriver));
  const layerOnboarding = ConnectionOnboarding.layer.pipe(Layer.provide(layerRegistry));
  const layerConnectionServices = Layer.mergeAll(
    layerRegistry,
    RelayEnvironmentDiscovery.layer,
    layerOnboarding,
    ConnectionResolver.layer,
  );
  const layerConnectionStartup = Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const platformSource = yield* PlatformConnectionSource.PlatformConnectionSource;
      yield* watchDiscoveredCompatibility().pipe(Effect.forkScoped);
      yield* registry.start;
      const lan = yield* ClientCapabilities.LanDiscoverySource;
      const connectivity = yield* Connectivity.Connectivity;
      const wakeups = yield* Wakeups.ConnectionWakeups;
      const refresh = yield* Queue.dropping<void>(1);
      yield* lan.services.pipe(
        Stream.runForEach((services) => {
          const candidates = new Map<EnvironmentId, string[]>();
          for (const service of services.slice(0, 128)) {
            if (
              !isEnvironmentId(service.environmentId) ||
              !Number.isInteger(service.port) ||
              service.port < 1 ||
              service.port > 65535
            )
              continue;
            const urls = candidates.get(service.environmentId) ?? [];
            for (const address of service.addresses.slice(0, 32))
              urls.push(`http://${address}:${service.port}/`);
            candidates.set(service.environmentId, urls);
          }
          return registry.setDiscoveredCandidates(candidates);
        }),
        Effect.forkScoped,
      );
      yield* Stream.mergeAll(
        [
          Stream.make(undefined),
          Stream.tick("30 seconds").pipe(Stream.as(undefined)),
          connectivity.changes.pipe(Stream.as(undefined)),
          wakeups.changes,
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Stream.runForEach(() => Queue.offer(refresh, undefined)),
        Effect.forkScoped,
      );
      yield* Effect.forever(Queue.take(refresh).pipe(Effect.andThen(lan.refresh))).pipe(
        Effect.forkScoped,
      );

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
