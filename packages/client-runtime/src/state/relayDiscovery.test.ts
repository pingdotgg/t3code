import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import * as RelayEnvironmentDiscovery from "../relay/discovery.ts";
import { createRelayEnvironmentDiscoveryAtoms } from "./relayDiscovery.ts";

function environmentRecord(id: string): RelayClientEnvironmentRecord {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    endpoint: {
      httpBaseUrl: `https://${id}.example.com`,
      wsBaseUrl: `wss://${id}.example.com`,
      providerKind: "cloudflare_tunnel",
    },
    linkedAt: "2026-10-01T00:00:00.000Z",
  };
}

describe("relay environment discovery refresh", () => {
  it.effect("re-lists when a refresh is requested while an earlier one is in flight", () =>
    Effect.gen(function* () {
      let relayEnvironments = [environmentRecord("studio"), environmentRecord("laptop")];
      const firstListingStarted = yield* Deferred.make<void>();
      const firstListingHeld = yield* Latch.make();
      let listings = 0;
      const state = yield* SubscriptionRef.make(
        RelayEnvironmentDiscovery.EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
      );
      const refreshLock = yield* Semaphore.make(1);
      const refresh = refreshLock.withPermits(1)(
        Effect.gen(function* () {
          const listed = relayEnvironments;
          listings++;
          if (listings === 1) {
            yield* Deferred.succeed(firstListingStarted, undefined);
            yield* firstListingHeld.await;
          }
          yield* SubscriptionRef.update(state, (current) => ({
            ...current,
            environments: new Map(
              listed.map((environment) => [
                environment.environmentId,
                {
                  environment,
                  availability: "online" as const,
                  status: Option.none(),
                  error: Option.none(),
                },
              ]),
            ),
          }));
        }),
      );
      const discovery = createRelayEnvironmentDiscoveryAtoms(
        Atom.runtime(
          Layer.succeed(
            RelayEnvironmentDiscovery.RelayEnvironmentDiscovery,
            RelayEnvironmentDiscovery.RelayEnvironmentDiscovery.of({ state, refresh }),
          ),
        ),
      );
      const registry = AtomRegistry.make();

      const staleRefresh = discovery.refresh.run(registry, undefined);
      yield* Deferred.await(firstListingStarted);
      // The environment is deregistered after the in-flight refresh already listed it.
      relayEnvironments = relayEnvironments.filter(
        (environment) => environment.environmentId !== "studio",
      );
      const refreshAfterUnlink = discovery.refreshAfterMutation.run(registry, undefined);
      yield* firstListingHeld.open;
      yield* Effect.promise(() => Promise.all([staleRefresh, refreshAfterUnlink]));

      const current = yield* SubscriptionRef.get(state);
      expect([...current.environments.keys()]).toEqual(["laptop"]);
      registry.dispose();
    }),
  );
});
