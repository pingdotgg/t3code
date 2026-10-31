import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import { discoverTailnetMachines as discoverTailnetMachinesEffect } from "@t3tools/client-runtime/state/tailnet";
import type { EnvironmentId, TailnetPeerEnvironment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairingUrl = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:connect-pairing-url",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    // The same link used for another machine needs its own expected-machine check.
    key: (input: { readonly pairingUrl: string; readonly expectedEnvironmentId?: EnvironmentId }) =>
      JSON.stringify([input.pairingUrl, input.expectedEnvironmentId ?? null]),
  },
  execute: (input: {
    readonly pairingUrl: string;
    readonly expectedEnvironmentId?: EnvironmentId;
  }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerPairing(input)),
    ),
});

/** Signs in through Tailscale with no code; None when the machine needs a pairing code. */
export const connectTailnet = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:connect-tailnet",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: ConnectionOnboarding.TailnetConnectionInput) => JSON.stringify(input),
  },
  execute: (input: ConnectionOnboarding.TailnetConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerTailnet(input)),
    ),
});

export const discoverTailnetMachines = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:discover-tailnet",
  scheduler: onboardingScheduler,
  concurrency: { mode: "singleFlight", key: () => "discover-tailnet" },
  execute: (found: ReadonlyArray<TailnetPeerEnvironment>) => discoverTailnetMachinesEffect(found),
});

export const updateBearerConnection = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:connection:update-bearer",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly environmentId: EnvironmentId }) => input.environmentId,
  },
  execute: (input: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly httpBaseUrl: string;
  }) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.updateBearer(input)),
    ),
});
