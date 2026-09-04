import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import * as RelayEnvironmentDiscovery from "../relay/discovery.ts";
import { createRuntimeCommand } from "./runtime.ts";

export function createRelayEnvironmentDiscoveryAtoms<R, E>(
  runtime: Atom.AtomRuntime<RelayEnvironmentDiscovery.RelayEnvironmentDiscovery | R, E>,
) {
  const stateAtom = runtime.atom(
    Stream.unwrap(
      RelayEnvironmentDiscovery.RelayEnvironmentDiscovery.pipe(
        Effect.map((discovery) => SubscriptionRef.changes(discovery.state)),
      ),
    ),
    { initialValue: RelayEnvironmentDiscovery.EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE },
  );
  const stateValueAtom = Atom.make((get) =>
    Option.getOrElse(
      AsyncResult.value(get(stateAtom)),
      () => RelayEnvironmentDiscovery.EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
    ),
  ).pipe(Atom.withLabel("relay-environment-discovery-value"));
  // `latest` rather than `singleFlight`: a refresh requested while one is in
  // flight must start a fresh pass once it settles. Callers refresh after
  // mutating the relay (linking, deregistering), and joining a pass that began
  // before the mutation landed would show the stale list as the final result.
  const refresh = createRuntimeCommand(runtime, {
    label: "relay-environment-discovery:refresh",
    concurrency: { mode: "latest", key: () => "refresh" },
    execute: (_input: void) =>
      RelayEnvironmentDiscovery.RelayEnvironmentDiscovery.pipe(
        Effect.flatMap((discovery) => discovery.refresh),
      ),
  });

  return {
    stateAtom,
    stateValueAtom,
    refresh,
  };
}
