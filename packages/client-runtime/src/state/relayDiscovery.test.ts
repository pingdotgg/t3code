import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
  RelayEnvironmentDiscovery,
} from "../relay/discovery.ts";
import { createRelayEnvironmentDiscoveryAtoms } from "./relayDiscovery.ts";

describe("createRelayEnvironmentDiscoveryAtoms", () => {
  it("runs a fresh refresh after the in-flight one when requested mid-flight", async () => {
    const firstRefresh = Latch.makeUnsafe();
    let markFirstRefreshStarted!: () => void;
    const firstRefreshStarted = new Promise<void>((resolve) => {
      markFirstRefreshStarted = resolve;
    });
    let refreshes = 0;
    const discoveryLayer = Layer.effect(
      RelayEnvironmentDiscovery,
      Effect.gen(function* () {
        const state = yield* SubscriptionRef.make(EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE);
        return RelayEnvironmentDiscovery.of({
          state,
          refresh: Effect.suspend(() => {
            refreshes += 1;
            if (refreshes !== 1) return Effect.void;
            markFirstRefreshStarted();
            return firstRefresh.await;
          }),
        });
      }),
    );
    const atoms = createRelayEnvironmentDiscoveryAtoms(Atom.runtime(discoveryLayer));
    const registry = AtomRegistry.make();

    const first = atoms.refresh.run(registry, undefined);
    await firstRefreshStarted;
    // Simulates a relay mutation that lands while the first pass is running.
    const second = atoms.refresh.run(registry, undefined);
    firstRefresh.openUnsafe();

    expect(await first).toMatchObject({ _tag: "Success" });
    expect(await second).toMatchObject({ _tag: "Success" });
    expect(refreshes).toBe(2);
    registry.dispose();
  });
});
