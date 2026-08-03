import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthAttachStreamEvent,
  type ProviderAuthSessionSnapshot,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import * as ProviderAuthSessionManager from "./ProviderAuthSessionManager.ts";
import { makeProviderAuthenticationCapability } from "./providerAuthentication.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { makeProviderRegistryMock } from "./testUtils/providerRegistryMock.ts";

const INSTANCE_ID = ProviderInstanceId.make("codex");
const PROVIDER: ServerProvider = {
  instanceId: INSTANCE_ID,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "warning",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-08-03T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

function testHarness(
  options: {
    readonly yieldBeforeSpawn?: boolean;
    readonly exitOnSpawn?: boolean;
    readonly refreshedAuth?: ServerProvider["auth"]["status"];
  } = {},
) {
  let onData: ((data: string) => void) | null = null;
  let onExit: ((event: PtyAdapter.PtyExitEvent) => void) | null = null;
  const writes: string[] = [];
  const resizes: Array<readonly [number, number]> = [];
  const signals: string[] = [];
  const spawns: PtyAdapter.PtySpawnInput[] = [];
  const authStates: unknown[] = [];
  let refreshes = 0;
  const process: PtyAdapter.PtyProcess = {
    pid: 42,
    write: (data) => writes.push(data),
    resize: (cols, rows) => resizes.push([cols, rows]),
    kill: (signal = "SIGTERM") => signals.push(signal),
    onData: (callback) => {
      onData = callback;
      return () => {
        onData = null;
      };
    },
    onExit: (callback) => {
      onExit = callback;
      return () => {
        onExit = null;
      };
    },
  };
  const instance = {
    instanceId: INSTANCE_ID,
    driverKind: ProviderDriverKind.make("codex"),
    enabled: true,
    authentication: makeProviderAuthenticationCapability({
      command: "codex",
      env: { PATH: "/bin", CODEX_HOME: "/home/t3/.codex" },
      signInArgs: ["login", "--device-auth"],
      signOutArgs: ["logout"],
      cwd: "/home/t3",
    }),
  } as ProviderInstance;
  const registry = makeProviderRegistryMock([PROVIDER]);
  const layer = Layer.mergeAll(
    Layer.succeed(PtyAdapter.PtyAdapter, {
      spawn: (input) =>
        Effect.gen(function* () {
          if (options.yieldBeforeSpawn) yield* Effect.yieldNow;
          spawns.push(input);
          if (options.exitOnSpawn) {
            queueMicrotask(() => onExit?.({ exitCode: 0, signal: null }));
          }
          return process;
        }),
    }),
    Layer.succeed(ProviderInstanceRegistry, {
      getInstance: () => Effect.succeed(instance),
      listInstances: Effect.succeed([instance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
    }),
    Layer.succeed(ProviderRegistry, {
      ...registry,
      refreshInstance: () =>
        Effect.sync(
          () => (
            (refreshes += 1),
            [
              {
                ...PROVIDER,
                auth: { status: options.refreshedAuth ?? "authenticated" },
              },
            ]
          ),
        ),
      setProviderAuthSessionState: (state) =>
        Effect.sync(() => (authStates.push(state.activeSession), [PROVIDER])),
    }),
  );
  return {
    layer,
    spawns,
    writes,
    resizes,
    signals,
    authStates,
    refreshCount: () => refreshes,
    emitData: (data: string) => onData?.(data),
    emitExit: (exitCode: number, signal: number | null = null) => onExit?.({ exitCode, signal }),
  };
}

describe("ProviderAuthSessionManager", () => {
  it.effect("starts a fixed PTY command and reconnects to the same active session", () =>
    Effect.gen(function* () {
      const harness = testHarness();
      const output = yield* Deferred.make<ProviderAuthAttachStreamEvent>();
      const settled = yield* Deferred.make<ProviderAuthAttachStreamEvent>();
      const program = Effect.gen(function* () {
        const manager = yield* ProviderAuthSessionManager.make();
        const first = yield* manager.start({
          instanceId: INSTANCE_ID,
          action: "signIn",
          cols: 88,
          rows: 22,
        });
        const second = yield* manager.start({ instanceId: INSTANCE_ID, action: "signIn" });
        expect(second.sessionId).toBe(first.sessionId);
        expect(harness.spawns).toEqual([
          {
            shell: "codex",
            args: ["login", "--device-auth"],
            cwd: "/home/t3",
            cols: 88,
            rows: 22,
            env: { PATH: "/bin", CODEX_HOME: "/home/t3/.codex" },
          },
        ]);
        yield* manager.attachStream({ sessionId: first.sessionId }, (event) =>
          event.type === "output"
            ? Deferred.succeed(output, event)
            : event.type === "settled"
              ? Deferred.succeed(settled, event)
              : Effect.void,
        );
        harness.emitData("Open https://login.example/device\nDevice code: ABCD-EFGH\n");
        const outputEvent = yield* Deferred.await(output);
        expect(outputEvent).toMatchObject({
          type: "output",
          data: "Open https://login.example/device\nDevice code: ABCD-EFGH\n",
        });
        yield* manager.write({ sessionId: first.sessionId, data: "yes\r" });
        yield* manager.resize({ sessionId: first.sessionId, cols: 100, rows: 30 });
        expect(harness.writes).toEqual(["yes\r"]);
        expect(harness.resizes).toEqual([[100, 30]]);
        harness.emitExit(0);
        const settledEvent = yield* Deferred.await(settled);
        expect(settledEvent).toMatchObject({
          type: "settled",
          snapshot: { status: "succeeded", exitCode: 0 },
        });
        expect(harness.refreshCount()).toBe(1);
        expect(harness.authStates).toEqual([
          { sessionId: first.sessionId, action: "signIn" },
          null,
        ]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
      yield* program;
    }),
  );

  it.effect("serializes concurrent starts for the same provider instance", () =>
    Effect.gen(function* () {
      const harness = testHarness({ yieldBeforeSpawn: true });
      const program = Effect.gen(function* () {
        const manager = yield* ProviderAuthSessionManager.make();
        const [first, second] = yield* Effect.all(
          [
            manager.start({ instanceId: INSTANCE_ID, action: "signIn" }),
            manager.start({ instanceId: INSTANCE_ID, action: "signIn" }),
          ],
          { concurrency: "unbounded" },
        );

        expect(second.sessionId).toBe(first.sessionId);
        expect(harness.spawns).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
      yield* program;
    }),
  );

  it.effect("settles a process that exits while startup is completing", () =>
    Effect.gen(function* () {
      const harness = testHarness({ exitOnSpawn: true });
      const program = Effect.gen(function* () {
        const manager = yield* ProviderAuthSessionManager.make();
        const session = yield* manager.start({ instanceId: INSTANCE_ID, action: "signIn" });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(harness.authStates).toEqual([
          { sessionId: session.sessionId, action: "signIn" },
          null,
        ]);
        const settled = yield* Deferred.make<ProviderAuthSessionSnapshot>();
        yield* manager.attachStream({ sessionId: session.sessionId }, (event) =>
          event.type === "snapshot" && event.snapshot.status !== "running"
            ? Deferred.succeed(settled, event.snapshot)
            : event.type === "settled"
              ? Deferred.succeed(settled, event.snapshot)
              : Effect.void,
        );
        expect(yield* Deferred.await(settled)).toMatchObject({
          status: "succeeded",
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
      yield* program;
    }),
  );

  it.effect("fails when a successful command leaves auth state unverifiable", () =>
    Effect.gen(function* () {
      const harness = testHarness({ refreshedAuth: "unknown" });
      const settled = yield* Deferred.make<ProviderAuthSessionSnapshot>();
      const program = Effect.gen(function* () {
        const manager = yield* ProviderAuthSessionManager.make();
        const session = yield* manager.start({ instanceId: INSTANCE_ID, action: "signIn" });
        yield* manager.attachStream({ sessionId: session.sessionId }, (event) =>
          event.type === "settled" ? Deferred.succeed(settled, event.snapshot) : Effect.void,
        );
        harness.emitExit(0);
        expect(yield* Deferred.await(settled)).toMatchObject({
          status: "failed",
          message: "Authentication command completed, but T3 Code could not verify the new state.",
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
      yield* program;
    }),
  );

  it.effect("rejects the opposite action while a session is active and cancels explicitly", () =>
    Effect.gen(function* () {
      const harness = testHarness();
      const program = Effect.gen(function* () {
        const manager = yield* ProviderAuthSessionManager.make();
        const session = yield* manager.start({ instanceId: INSTANCE_ID, action: "signIn" });
        const conflict = yield* Effect.flip(
          manager.start({ instanceId: INSTANCE_ID, action: "signOut" }),
        );
        expect(conflict.reason).toBe("session-conflict");
        yield* manager.cancel({ sessionId: session.sessionId });
        expect(harness.signals).toEqual(["SIGTERM"]);
        harness.emitExit(143, 15);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
      yield* program;
    }),
  );
});
