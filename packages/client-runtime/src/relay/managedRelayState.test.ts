import { EnvironmentId } from "@t3tools/contracts";
import {
  type RelayClientDeviceRecord,
  type RelayClientEnvironmentRecord,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, vi } from "vite-plus/test";

import * as ManagedRelay from "./managedRelay.ts";
import {
  createManagedRelayQueryManager,
  createManagedRelaySession,
  deregisterManagedRelayEnvironment,
  ManagedRelaySessionError,
  managedRelaySessionAtom,
  setManagedRelaySession,
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

function createClient(overrides?: Partial<ManagedRelay.ManagedRelayClient["Service"]>) {
  return ManagedRelay.ManagedRelayClient.of({
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
    getAgentActivitySnapshot: () => Effect.die("unused"),
    resetTokenCache: Effect.void,
    ...overrides,
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

  it.effect("logs a failed device listing once however many readers mount it", () =>
    Effect.gen(function* () {
      const logs: Array<unknown> = [];
      const runtime = Atom.runtime(
        Layer.mergeAll(
          Layer.succeed(
            ManagedRelay.ManagedRelayClient,
            createClient({
              listDevices: () =>
                Effect.fail(
                  new ManagedRelay.ManagedRelayRequestFailedError({
                    action: "list relay client devices",
                    cause: new Error("relay down"),
                  }),
                ),
            }),
          ),
          Logger.layer([Logger.make(({ message }) => logs.push(message))], {
            mergeWithExisting: false,
          }),
        ),
      );
      const manager = createManagedRelayQueryManager(runtime);
      setSession();
      const atom = manager.devicesAtom("account-1");

      const failed = Promise.withResolvers<void>();
      const readers = [0, 1].map(() =>
        registry.subscribe(
          atom,
          (result) => {
            if (result._tag === "Failure") failed.resolve();
          },
          { immediate: true },
        ),
      );
      yield* Effect.promise(() => failed.promise);
      for (const unsubscribe of readers) unsubscribe();

      expect(logs).toEqual([["[t3-cloud] Relay device listing failed"]]);
    }),
  );

  it.effect("rejects deregistration after the account changes", () =>
    Effect.gen(function* () {
      const unlinkEnvironment = vi.fn(() => Effect.succeed({ ok: true }));
      setSession();

      const error = yield* deregisterManagedRelayEnvironment(registry, {
        accountId: "previous-account",
        environmentId: environment.environmentId,
      }).pipe(
        Effect.provideService(ManagedRelay.ManagedRelayClient, createClient({ unlinkEnvironment })),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(ManagedRelaySessionError);
      expect(unlinkEnvironment).not.toHaveBeenCalled();
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
});
