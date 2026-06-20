import { EnvironmentId } from "@t3tools/contracts";
import type {
  RelayClientDeviceRecord,
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, vi } from "vite-plus/test";

import * as ManagedRelay from "./managedRelay.ts";
import {
  createManagedRelayQueryManager,
  createManagedRelaySession,
  managedRelayAccountChanges,
  type ManagedRelayQueryEvent,
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

function createManager(
  overrides?: Partial<ManagedRelay.ManagedRelayClient["Service"]>,
  onQueryEvent?: (event: ManagedRelayQueryEvent) => void,
) {
  const client = ManagedRelay.ManagedRelayClient.of({
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
  const runtime = Atom.runtime(Layer.succeed(ManagedRelay.ManagedRelayClient, client));
  return createManagedRelayQueryManager(runtime, {
    staleTimeMs: 60_000,
    ...(onQueryEvent ? { onQueryEvent } : {}),
  });
}

function setSession() {
  setManagedRelaySession(registry, {
    accountId: "account-1",
    readClerkToken: () => Promise.resolve("clerk-token"),
  });
}

function clerkToken(expiresAtSeconds: number): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `${encode({ alg: "none" })}.${encode({ exp: expiresAtSeconds })}.signature`;
}

describe("createManagedRelayQueryManager", () => {
  afterEach(resetRegistry);

  it.effect("waits for the current cloud session before reading its token", () =>
    Effect.gen(function* () {
      const tokenFiber = yield* waitForManagedRelayClerkToken(registry).pipe(Effect.forkChild);

      setSession();

      expect(yield* Fiber.join(tokenFiber)).toBe("clerk-token");
      expect(registry.getNodes().get(managedRelaySessionAtom)?.listeners.size).toBe(0);
    }),
  );

  it.effect("deduplicates concurrent Clerk token reads and reuses the token until JWT expiry", () =>
    Effect.gen(function* () {
      const token = clerkToken(4_102_444_800);
      let resolveToken!: (value: string) => void;
      const readClerkToken = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveToken = resolve;
          }),
      );
      const session = createManagedRelaySession({
        accountId: "account-1",
        readClerkToken,
      });

      const readsFiber = yield* Effect.all([session.readClerkToken(), session.readClerkToken()], {
        concurrency: "unbounded",
      }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(readClerkToken).toHaveBeenCalledTimes(1);

      resolveToken(token);
      expect(yield* Fiber.join(readsFiber)).toEqual([token, token]);
      expect(yield* session.readClerkToken()).toBe(token);
      expect(readClerkToken).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("updates the token provider without replacing a same-account session", () =>
    Effect.gen(function* () {
      const firstRead = vi.fn(() => Promise.resolve<string | null>(null));
      setManagedRelaySession(registry, {
        accountId: "account-1",
        readClerkToken: firstRead,
      });
      const firstSession = registry.get(managedRelaySessionAtom);
      expect(firstSession).not.toBeNull();
      expect(yield* firstSession!.readClerkToken()).toBeNull();

      const secondRead = vi.fn(() => Promise.resolve<string | null>("refreshed-token"));
      setManagedRelaySession(registry, {
        accountId: "account-1",
        readClerkToken: secondRead,
      });

      expect(registry.get(managedRelaySessionAtom)).toBe(firstSession);
      expect(yield* firstSession!.readClerkToken()).toBe("refreshed-token");
      expect(firstRead).toHaveBeenCalledTimes(1);
      expect(secondRead).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("does not pin a refreshed session to an older pending token read", () =>
    Effect.gen(function* () {
      let resolveFirst!: (token: string) => void;
      setManagedRelaySession(registry, {
        accountId: "account-1",
        readClerkToken: () =>
          new Promise<string>((resolve) => {
            resolveFirst = resolve;
          }),
      });
      const session = registry.get(managedRelaySessionAtom);
      const firstRead = yield* session!.readClerkToken().pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      setManagedRelaySession(registry, {
        accountId: "account-1",
        readClerkToken: () => Promise.resolve("refreshed-token"),
      });

      expect(yield* session!.readClerkToken()).toBe("refreshed-token");
      resolveFirst("older-token");
      expect(yield* Fiber.join(firstRead)).toBe("older-token");
    }),
  );

  it("emits credential changes only when the managed relay account changes", async () => {
    setManagedRelaySession(registry, {
      accountId: "account-1",
      readClerkToken: () => Promise.resolve("first-token"),
    });
    const changes = Effect.runPromise(
      managedRelayAccountChanges(registry).pipe(Stream.take(2), Stream.runCollect),
    );
    await vi.waitFor(() => {
      expect(registry.getNodes().get(managedRelaySessionAtom)?.listeners.size).toBeGreaterThan(0);
    });

    setManagedRelaySession(registry, {
      accountId: "account-1",
      readClerkToken: () => Promise.resolve("refreshed-token"),
    });
    setManagedRelaySession(registry, {
      accountId: "account-2",
      readClerkToken: () => Promise.resolve("second-token"),
    });
    setManagedRelaySession(registry, null);

    expect(Array.from(await changes)).toEqual(["account-2", null]);
  });

  it("shares one Clerk token read across concurrent relay list and status queries", async () => {
    const secondEnvironment = {
      ...environment,
      environmentId: EnvironmentId.make("environment-2"),
      label: "Second environment",
      endpoint: {
        ...environment.endpoint,
        httpBaseUrl: "https://environment-2.example.test",
        wsBaseUrl: "wss://environment-2.example.test",
      },
    } satisfies RelayClientEnvironmentRecord;
    const token = clerkToken(4_102_444_800);
    const readClerkToken = vi.fn(() => Promise.resolve(token));
    const manager = createManager({
      listEnvironments: () => Effect.succeed([environment, secondEnvironment]),
      getEnvironmentStatus: ({ environmentId }) => {
        const current =
          environmentId === environment.environmentId ? environment : secondEnvironment;
        return Effect.succeed({
          environmentId: current.environmentId,
          endpoint: current.endpoint,
          status: "online" as const,
          checkedAt: "2026-06-01T00:00:00.000Z",
        });
      },
    });
    setManagedRelaySession(registry, {
      accountId: "account-1",
      readClerkToken,
    });

    const environmentsAtom = manager.environmentsAtom("account-1");
    const firstStatusAtom = manager.environmentStatusAtom({
      accountId: "account-1",
      environment,
    });
    const secondStatusAtom = manager.environmentStatusAtom({
      accountId: "account-1",
      environment: secondEnvironment,
    });
    registry.get(environmentsAtom);
    registry.get(firstStatusAtom);
    registry.get(secondStatusAtom);

    await vi.waitFor(() => {
      expect(readManagedRelaySnapshotState(registry.get(firstStatusAtom)).data?.status).toBe(
        "online",
      );
      expect(readManagedRelaySnapshotState(registry.get(secondStatusAtom)).data?.status).toBe(
        "online",
      );
    });
    expect(readClerkToken).toHaveBeenCalledTimes(1);
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

  it("reports token and relay request phases for environment status queries", async () => {
    const onQueryEvent = vi.fn();
    const manager = createManager(undefined, onQueryEvent);
    setSession();
    const atom = manager.environmentStatusAtom({ accountId: "account-1", environment });

    registry.get(atom);
    await vi.waitFor(() => {
      expect(readManagedRelaySnapshotState(registry.get(atom)).data?.status).toBe("online");
    });

    expect(onQueryEvent).toHaveBeenCalledWith({
      operation: "environment-status",
      stage: "clerk-token",
      phase: "start",
      accountId: "account-1",
      environmentId: environment.environmentId,
    });
    expect(onQueryEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "environment-status",
        stage: "relay-request",
        phase: "success",
        accountId: "account-1",
        environmentId: environment.environmentId,
      }),
    );
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

  it("exposes relay trace IDs alongside snapshot errors", async () => {
    const manager = createManager({
      getEnvironmentStatus: () =>
        Effect.fail(
          new ManagedRelay.ManagedRelayRequestFailedError({
            action: "get relay environment status",
            cause: new Error("Relay request failed."),
            traceId: "trace-status",
          }),
        ),
    });
    setSession();
    const atom = manager.environmentStatusAtom({ accountId: "account-1", environment });

    registry.get(atom);
    await vi.waitFor(() => {
      expect(readManagedRelaySnapshotState(registry.get(atom))).toMatchObject({
        error: "Could not get relay environment status.",
        errorTraceId: "trace-status",
      });
    });
  });
});
