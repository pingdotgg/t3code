import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import { discoverTailnetMachines as discoverTailnetMachinesEffect } from "@t3tools/client-runtime/state/tailnet";
import type { DesktopSshEnvironmentTarget, TailnetPeerEnvironment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-pairing",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: ConnectionOnboarding.PairingConnectionInput) => JSON.stringify(input),
  },
  execute: (input: ConnectionOnboarding.PairingConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerPairing(input)),
    ),
});

/** Signs in through Tailscale with no code; None when the machine needs a pairing code. */
export const connectTailnet = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-tailnet",
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
  label: "web:connection:discover-tailnet",
  scheduler: onboardingScheduler,
  concurrency: { mode: "singleFlight", key: () => "discover-tailnet" },
  execute: (found: ReadonlyArray<TailnetPeerEnvironment>) => discoverTailnetMachinesEffect(found),
});

export const connectSshEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-ssh",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) => JSON.stringify(input.target),
  },
  execute: (input: ConnectionOnboarding.SshConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerSsh(input)),
    ),
});
