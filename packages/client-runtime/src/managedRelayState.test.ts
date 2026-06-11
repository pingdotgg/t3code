import { EnvironmentId } from "@t3tools/contracts";
import type {
  RelayClientDeviceRecord,
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ManagedRelayClient, type ManagedRelayClientShape } from "./managedRelay.ts";
import {
  createManagedRelayQueryManager,
  createManagedRelaySession,
  managedRelaySessionAtom,
  readManagedRelaySnapshotState,
  setManagedRelaySession,
  waitForManagedRelayClerkToken,
} from "./managedRelayState.ts";

let registry = AtomRegistry.make();

const environment = {
  environmentId: EnvironmentId.make("environment-1"),
  label: "Main environment",
  endpoint: {
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
    providerKind: "cloudflare_tunnel",
  },
  linkedAt: "2026-06-01T00:00:00.000Z",
} satisfies RelayClientEnvironmentRecord;

const device = {
  deviceId: "device-1",
  label: "Julius iPhone",
  platform: "ios",
  iosMajorVersion: 18,
  appVersion: null,
  notifications: {
    enabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
  liveActivities: {
    enabled: true,
  },
  updatedAt: "2026-06-01T00:00:00.000Z",
} satisfies RelayClientDeviceRecord;

function resetRegistry() {
  registry.dispose();
  registry = AtomRegistry.make();
}

function createManager(overrides?: Partial<ManagedRelayClientShape>) {
  const client = ManagedRelayClient.of({
    relayUrl: "https://relay.example.test",
    listEnvironments: () => Effect.succeed([environment]),
    listDevices: () => Effect.succeed([device]),
    createEnvironmentLinkChallenge: () => Effect.die("unused"),
    linkEnvironment: () => Effect.die("unused"),
    unlinkEnvironment: () => Effect.die("unused"),
    getEnvironmentStatus: () =>
      Effect.succeed({
        environmentId: environment.environmentId,
        endpoint: environment.endpoint,
        status: "online",
        checkedAt: "2026-06-01T00:00:00.000Z",
      }),
    connectEnvironment: () => Effect.die("unused"),
    registerDevice: () => Effect.die("unused"),
    unregisterDevice: () => Effect.die("unused"),
    registerLiveActivity: () => Effect.die("unused"),
    resetTokenCache: Effect.void,
    ...overrides,
  });
  const runtime = Atom.runtime(Layer.succeed(ManagedRelayClient, client));
  return createManagedRelayQueryManager(runtime, { staleTimeMs: 60_000 });
}

function setSession() {
  setManagedRelaySession(
    registry,
    createManagedRelaySession({
      accountId: "account-1",
      readClerkToken: () => Promise.resolve("clerk-token"),
    }),
  );
}

describe("createManagedRelayQueryManager", () => {
  afterEach(resetRegistry);

  it("waits for the current cloud session before reading its token", async () => {
    const token = Effect.runPromise(waitForManagedRelayClerkToken(registry));

    setSession();

    await expect(token).resolves.toBe("clerk-token");
    expect(registry.getNodes().get(managedRelaySessionAtom)?.listeners.size).toBe(0);
  });

  it("keeps environment snapshots cached and refreshes them explicitly", async () => {
    const listEnvironments = vi.fn(() => Effect.succeed([environment]));
    const manager = createManager({ listEnvironments });
    setSession();
    const atom = manager.environmentsAtom("account-1");

    registry.get(atom);
    await vi.waitFor(() => expect(listEnvironments).toHaveBeenCalledTimes(1));

    registry.get(manager.environmentsAtom("account-1"));
    expect(listEnvironments).toHaveBeenCalledTimes(1);

    manager.refreshEnvironments(registry, "account-1");
    await vi.waitFor(() => expect(listEnvironments).toHaveBeenCalledTimes(2));
  });

  it("loads device snapshots through the current account session", async () => {
    const listDevices = vi.fn(() => Effect.succeed([device]));
    const manager = createManager({ listDevices });
    setSession();
    const atom = manager.devicesAtom("account-1");

    registry.get(atom);
    await vi.waitFor(() => {
      expect(readManagedRelaySnapshotState(registry.get(atom)).data).toEqual([device]);
    });
  });

  it("rejects status responses for a different environment", async () => {
    const mismatchedStatus = {
      environmentId: EnvironmentId.make("environment-2"),
      endpoint: environment.endpoint,
      status: "online",
      checkedAt: "2026-06-01T00:00:00.000Z",
    } satisfies RelayEnvironmentStatusResponse;
    const manager = createManager({
      getEnvironmentStatus: () => Effect.succeed(mismatchedStatus),
    });
    setSession();
    const atom = manager.environmentStatusAtom({ accountId: "account-1", environment });

    registry.get(atom);
    await vi.waitFor(() => {
      expect(readManagedRelaySnapshotState(registry.get(atom)).error).toBe(
        "Relay returned status for a different environment.",
      );
    });
  });
});
