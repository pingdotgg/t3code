import {
  EnvironmentId,
  ServerSelfUpdateError,
  ProviderInstanceId,
  ServerObservability,
  EnvironmentThemeId,
  UsageLimitSourceId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { RpcPermissionGuard } from "../rpc/client.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  applyServerWelcomeEvent,
  createServerEnvironmentAtoms,
  serverUpdateStateAtom,
  makeEnvironmentServerWelcomeState,
  makeEnvironmentServerConfigState,
  isLegacyUpdateHandoffLoss,
  recordFetchedWorkspaceSnapshot,
  withFetchedWorkspaceSnapshots,
  matchesServerUpdateReadyEvent,
  matchesServerUpdateResumeEvent,
  nudgeReconnectDuringUpdateRestart,
  resolveServerConfigValue,
  resolveServerWelcomeState,
  resolveServerUpdateProgressResult,
  serverUpdateStateForProgressEvent,
  serverUpdateStateForServerVersion,
  validateServerUpdateReadyEvent,
  waitForNextEnvironmentReconnect,
  waitForDesktopUpdateTarget,
  runDesktopCommitWithReconnectObserver,
} from "./server.ts";
import { applyServerConfigProjection } from "./serverConfigProjection.ts";

const CONFIG = {
  availableEditors: [],
  issues: [],
  keybindings: {},
  keybindingsConfigPath: null,
  observability: null,
  providers: [],
  settings: {},
  environment: { capabilities: { environmentThemes: true } },
} as unknown as ServerConfig;

const snapshotEvent = (config: ServerConfig): ServerConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config,
});

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.succeed(CONFIG),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

describe("update restart reconnect nudges", () => {
  it.effect("retries a desktop commit that was lost before delivery", () =>
    Effect.gen(function* () {
      const readyEvents =
        yield* Queue.unbounded<Parameters<typeof matchesServerUpdateReadyEvent>[1]>();
      const ready = (serverVersion: string) =>
        ({
          version: 1 as const,
          sequence: 1,
          type: "ready" as const,
          payload: {
            at: "2026-09-01T00:00:00.000Z",
            environment: { serverVersion },
          },
        }) as Parameters<typeof matchesServerUpdateReadyEvent>[1];
      yield* Queue.offerAll(readyEvents, [ready("0.0.30"), ready("0.0.31")]);
      const retries = yield* Ref.make(0);
      const disconnect = new RpcClientError.RpcClientError({
        reason: new Socket.SocketCloseError({ code: 1006 }),
      });

      const result = yield* waitForDesktopUpdateTarget(
        "0.0.31",
        Queue.take(readyEvents),
        Ref.update(retries, (count) => count + 1).pipe(Effect.andThen(Effect.fail(disconnect))),
      );

      expect(result.payload.environment.serverVersion).toBe("0.0.31");
      expect(yield* Ref.get(retries)).toBe(1);
    }),
  );
  it.effect("observes a fast reconnect even when the caller awaits it later", () =>
    Effect.gen(function* () {
      const states = yield* Queue.unbounded<{ readonly phase: string }>();
      const reconnected = yield* waitForNextEnvironmentReconnect(Stream.fromQueue(states)).pipe(
        Effect.forkChild,
      );
      yield* Queue.offerAll(states, [
        { phase: "connected" },
        { phase: "backoff" },
        { phase: "connected" },
      ]);

      yield* Fiber.join(reconnected);
    }),
  );
  it.effect("arms the retry observer before a commit can disconnect", () =>
    Effect.gen(function* () {
      const allowSubscription = yield* Deferred.make<void>();
      const subscriptionStarted = yield* Deferred.make<void>();
      const states = yield* Queue.unbounded<{ readonly phase: string }>();
      const commits = yield* Ref.make(0);
      const disconnect = new RpcClientError.RpcClientError({
        reason: new Socket.SocketCloseError({ code: 1006 }),
      });
      const stateChanges = Stream.unwrap(
        Deferred.succeed(subscriptionStarted, undefined).pipe(
          Effect.andThen(Deferred.await(allowSubscription)),
          Effect.as(Stream.fromQueue(states)),
        ),
      );
      const retry = yield* runDesktopCommitWithReconnectObserver(
        stateChanges,
        Ref.update(commits, (count) => count + 1).pipe(
          Effect.andThen(Queue.offerAll(states, [{ phase: "backoff" }, { phase: "connected" }])),
          Effect.andThen(Effect.fail(disconnect)),
        ),
      ).pipe(Effect.flip, Effect.forkChild);

      yield* Deferred.await(subscriptionStarted);
      expect(yield* Ref.get(commits)).toBe(0);
      yield* Deferred.succeed(allowSubscription, undefined);
      yield* Queue.offer(states, { phase: "connected" });

      expect(yield* Fiber.join(retry)).toBe(disconnect);
      expect(yield* Ref.get(commits)).toBe(1);
    }),
  );
  it.effect("retries once per backoff entry instead of only the first", () =>
    Effect.gen(function* () {
      const retries = yield* Ref.make(0);
      const states = [
        { phase: "backoff" },
        { phase: "connecting" },
        { phase: "backoff" },
        { phase: "backoff" },
      ];

      yield* nudgeReconnectDuringUpdateRestart({
        stateChanges: Stream.fromIterable(states),
        retryNow: Ref.update(retries, (count) => count + 1),
        interval: Duration.zero,
      });

      expect(yield* Ref.get(retries)).toBe(3);
    }),
  );

  it.effect("retries rejected credentials only while the update restart is in progress", () =>
    Effect.gen(function* () {
      const retries = yield* Ref.make(0);

      yield* nudgeReconnectDuringUpdateRestart({
        stateChanges: Stream.fromIterable([
          { phase: "blocked", lastFailure: { reason: "permission" } },
          {
            phase: "blocked",
            lastFailure: {
              reason: "authentication",
              detail: "The environment credential is invalid.",
            },
          },
          { phase: "blocked", lastFailure: { reason: "configuration" } },
        ]),
        retryNow: Ref.update(retries, (count) => count + 1),
        interval: Duration.zero,
      });

      expect(yield* Ref.get(retries)).toBe(1);
    }),
  );
});

describe("accepted server update recovery", () => {
  it.effect.each([
    { loss: "interrupt", resumes: true },
    { loss: "socket", resumes: true },
    { loss: "server_error", resumes: false },
    { loss: "no_progress", resumes: false },
    { loss: "cancel", resumes: false },
    { loss: "socket", method: "respawn", resumes: true },
    { loss: "socket", method: "desktop-managed", resumes: false },
  ] as const)("handles $loss with $method and recovery=$resumes", (scenario) =>
    Effect.gen(function* () {
      const { loss, resumes } = scenario;
      const method = "method" in scenario ? scenario.method : "boot-service";
      const observing = yield* Deferred.make<void>();
      const cancelFiber = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>();
      const oldReadyObserved = yield* Deferred.make<void>();
      const readyEvents =
        yield* Queue.unbounded<Parameters<typeof matchesServerUpdateReadyEvent>[1]>();
      const config = {
        ...CONFIG,
        environment: {
          ...CONFIG.environment,
          serverVersion: "0.0.30",
          capabilities: { serverSelfUpdate: method, serverSelfUpdateProgress: true },
        },
      } as ServerConfig;
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => Stream.never,
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(observing, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromQueue(readyEvents)),
            Stream.tap((event) =>
              event.payload.environment.serverVersion === "0.0.30"
                ? Deferred.succeed(oldReadyObserved, undefined)
                : Effect.void,
            ),
          ),
        [WS_METHODS.serverUpdateServerWithProgress]: () =>
          (loss === "no_progress"
            ? Stream.empty
            : Stream.make({ type: "progress" as const, stage: "downloading" as const })
          ).pipe(
            Stream.concat(
              Stream.fromEffect(
                loss === "cancel"
                  ? Effect.fiber.pipe(
                      Effect.flatMap((fiber) => Deferred.succeed(cancelFiber, fiber)),
                      Effect.andThen(Effect.never),
                    )
                  : loss === "interrupt"
                    ? Effect.interrupt
                    : Effect.fail(
                        loss === "server_error"
                          ? new ServerSelfUpdateError({
                              reason: "Archive verification failed.",
                            })
                          : new RpcClientError.RpcClientError({
                              reason: new Socket.SocketCloseError({ code: 1006 }),
                            }),
                      ),
              ),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const runStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["runStream"] = (
        _id,
        stream,
      ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
      const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
        run,
        runStream,
        followStream: runStream,
        stateChanges: () => Stream.never,
        retryNow: () => Effect.void,
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const runtime = Atom.runtime(
        Layer.mergeAll(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
          Layer.succeed(RpcPermissionGuard, { authorize: () => Effect.void }),
          Layer.succeed(Persistence.EnvironmentCacheStore, {
            loadServerConfig: () => Effect.succeedNone,
          } as unknown as Persistence.EnvironmentCacheStore["Service"]),
        ),
      );
      const atoms = createServerEnvironmentAtoms(runtime, {
        initialConfigValueAtom: () => Atom.make(config),
      });
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
        Effect.sync(() => value.dispose()),
      );
      const pending = atoms.updateServer.run(registry, {
        environmentId: TARGET.environmentId,
        input: { targetVersion: "0.0.31" },
      });
      if (loss === "cancel") {
        yield* Fiber.interrupt(yield* Deferred.await(cancelFiber));
        const cancelled = yield* Effect.promise(() => pending);
        expect(cancelled._tag).toBe("Failure");
        if (cancelled._tag === "Failure")
          expect(Cause.hasInterruptsOnly(cancelled.cause)).toBe(true);
        expect(registry.get(serverUpdateStateAtom(TARGET.environmentId))).toEqual({
          status: "idle",
        });
        expect(yield* Deferred.isDone(observing)).toBe(false);
        return;
      }
      const first = yield* Effect.raceFirst(
        Effect.promise(() => pending).pipe(Effect.as("settled")),
        Deferred.await(observing).pipe(Effect.as("observing")),
      );
      if (!resumes) {
        expect(first).toBe("settled");
        expect(AsyncResult.isFailure(yield* Effect.promise(() => pending))).toBe(true);
        expect(registry.get(serverUpdateStateAtom(TARGET.environmentId))).toMatchObject({
          status: "failed",
        });
        return;
      }
      expect(first).toBe("observing");
      expect(registry.get(serverUpdateStateAtom(TARGET.environmentId))).toMatchObject({
        status: "running",
        stage: "resuming",
      });
      const ready = (serverVersion: string) =>
        ({
          version: 1,
          sequence: 1,
          type: "ready",
          payload: { at: "2026-09-01T00:00:00.000Z", environment: { serverVersion } },
        }) as Parameters<typeof matchesServerUpdateReadyEvent>[1];
      yield* Queue.offer(readyEvents, ready("0.0.30"));
      yield* Deferred.await(oldReadyObserved);
      expect(registry.get(serverUpdateStateAtom(TARGET.environmentId))).toMatchObject({
        status: "running",
      });
      yield* Queue.offer(readyEvents, ready("0.0.31"));
      expect(AsyncResult.isSuccess(yield* Effect.promise(() => pending))).toBe(true);
      expect(registry.get(serverUpdateStateAtom(TARGET.environmentId))).toEqual({
        status: "idle",
      });
    }).pipe(Effect.scoped),
  );
});

const makeConfigPersistenceHarness = Effect.fn("test.makeConfigPersistenceHarness")(function* (
  saveServerConfig: Persistence.EnvironmentCacheStore["Service"]["saveServerConfig"],
) {
  const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
  const client = {
    [WS_METHODS.subscribeServerConfig]: () => Stream.fromQueue(events),
  } as unknown as WsRpcProtocolClient;
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session(client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedSome(CONFIG),
    saveServerConfig,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const state = yield* makeEnvironmentServerConfigState({
    environmentThemes: true,
    usageLimitSources: true,
  }).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
  );
  const send = Effect.fn("test.sendConfigEvent")(function* (event: ServerConfigStreamEvent) {
    yield* Queue.offer(events, event);
    return yield* SubscriptionRef.changes(state).pipe(
      Stream.filter(Option.isSome),
      Stream.map((value) => value.value),
      Stream.filter((projection) => projection.latestEvent === event),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  });
  return { send };
});

describe("server state projection", () => {
  it.effect("skips duplicate keybinding saves but persists changed keybindings", () =>
    Effect.gen(function* () {
      const saved = yield* Ref.make<ReadonlyArray<ServerConfig>>([]);
      const keybindingsEvent = (key: string): ServerConfigStreamEvent => ({
        version: 1,
        type: "keybindingsUpdated",
        payload: {
          keybindings: [
            {
              command: "terminal.toggle",
              shortcut: {
                key,
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                modKey: true,
              },
            },
          ],
          issues: [],
        },
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeConfigPersistenceHarness((_id, config) =>
            Ref.update(saved, (values) => [...values, config]),
          );
          const first = yield* h.send(keybindingsEvent("p"));
          yield* TestClock.adjust("500 millis");
          expect(yield* Ref.get(saved)).toEqual([first.config]);

          yield* h.send(keybindingsEvent("p"));
          yield* TestClock.adjust("10 seconds");
          expect(yield* Ref.get(saved)).toEqual([first.config]);

          const changed = yield* h.send(keybindingsEvent("q"));
          yield* TestClock.adjust("10 seconds");
          expect(yield* Ref.get(saved)).toEqual([first.config, changed.config]);
        }),
      );
    }),
  );

  it.effect(
    "compares nested durable values independently of key order and omitted undefined fields",
    () =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ServerConfig>>([]);
        const observability = {
          logsDirectoryPath: "/synthetic/logs",
          localTracingEnabled: false,
          otlpTracesEnabled: false,
          otlpMetricsEnabled: false,
          otlpLogsEnabled: false,
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const h = yield* makeConfigPersistenceHarness((_id, config) =>
              Ref.update(saved, (values) => [...values, config]),
            );
            const first = yield* h.send(snapshotEvent({ ...CONFIG, observability }));
            yield* TestClock.adjust("500 millis");
            const reordered = Object.fromEntries(
              Object.entries(observability).toReversed(),
            ) as typeof observability;
            for (const next of [
              { ...CONFIG, observability: reordered },
              { ...CONFIG, observability: { ...reordered, otlpTracesUrl: undefined } },
              { ...CONFIG, observability: { ...observability } },
            ]) {
              const encode = Schema.encodeEffect(Schema.fromJsonString(ServerObservability));
              expect(JSON.parse(yield* encode(next.observability))).toEqual(
                JSON.parse(yield* encode(observability)),
              );
              const projection = yield* h.send(snapshotEvent(next));
              expect(projection.config.observability).toEqual(next.observability);
              yield* TestClock.adjust("10 seconds");
              expect.soft(yield* Ref.get(saved)).toEqual([first.config]);
            }
            const writesBeforeChange = (yield* Ref.get(saved)).length;
            const changed = yield* h.send(
              snapshotEvent({
                ...CONFIG,
                observability: { ...observability, otlpTracesUrl: "https://traces.example.test" },
              }),
            );
            yield* TestClock.adjust("10 seconds");
            expect((yield* Ref.get(saved)).length).toBe(writesBeforeChange + 1);
            expect((yield* Ref.get(saved)).at(-1)).toEqual(changed.config);
          }),
        );
      }),
  );

  it.effect("saves once across transient themes, usage sources and stall updates", () =>
    Effect.gen(function* () {
      const saved = yield* Ref.make<ReadonlyArray<ServerConfig>>([]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeConfigPersistenceHarness((_id, config) =>
            Ref.update(saved, (values) => [...values, config]),
          );
          yield* h.send(snapshotEvent(CONFIG));
          yield* TestClock.adjust("500 millis");
          expect((yield* Ref.get(saved)).length).toBe(1);
          for (const event of [
            {
              version: 1,
              type: "environmentThemesUpdated",
              payload: {
                themes: [
                  {
                    id: EnvironmentThemeId.make("theme-test"),
                    name: "Test theme",
                    appearance: "dark",
                  },
                ],
              },
            },
            {
              version: 1,
              type: "usageLimitSourcesUpdated",
              payload: {
                sources: [
                  {
                    id: UsageLimitSourceId.make("source-test"),
                    kind: "cliproxy",
                    label: "Test source",
                    checkedAt: "2026-10-20T07:50:37.633Z",
                    accounts: [],
                  },
                ],
              },
            },
            snapshotEvent({
              ...CONFIG,
              lastEventLoopStall: {
                detectedAt: "2026-10-20T07:50:37.633Z",
                durationMs: 1000,
                loadAverage: 1,
                cpuCount: 8,
              },
            }),
          ] satisfies ReadonlyArray<ServerConfigStreamEvent>) {
            const projection = yield* h.send(event);
            expect(projection.latestEvent).toBe(event);
            if (event.type === "environmentThemesUpdated")
              expect(projection.config.environmentThemes).toEqual(event.payload.themes);
            if (event.type === "usageLimitSourcesUpdated")
              expect(projection.config.usageLimitSources).toEqual(event.payload.sources);
            yield* TestClock.adjust("10 seconds");
          }
        }),
      );
      expect(yield* Ref.get(saved)).toEqual([CONFIG]);
    }),
  );

  it.effect("flushes pending durable changes after a transient event", () =>
    Effect.gen(function* () {
      const saved = yield* Ref.make<ReadonlyArray<ServerConfig>>([]);
      const changed = { ...CONFIG, keybindingsConfigPath: "/changed/keybindings.json" };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeConfigPersistenceHarness((_id, config) =>
            Ref.update(saved, (values) => [...values, config]),
          );
          yield* h.send(snapshotEvent(CONFIG));
          yield* TestClock.adjust("500 millis");
          yield* h.send(snapshotEvent(changed));
          yield* h.send({ version: 1, type: "environmentThemesUpdated", payload: { themes: [] } });
        }),
      );
      expect(yield* Ref.get(saved)).toEqual([CONFIG, changed]);
    }),
  );

  it.effect("retries a failed durable save on a transient event", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make<ReadonlyArray<ServerConfig>>([]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeConfigPersistenceHarness((_id, config) =>
            Effect.gen(function* () {
              const values = yield* Ref.updateAndGet(attempts, (values) => [...values, config]);
              if (values.length === 1)
                return yield* new Persistence.ConnectionPersistenceError({
                  operation: "save-server-config",
                  message: "test failure",
                });
            }),
          );
          yield* h.send(snapshotEvent(CONFIG));
          yield* TestClock.adjust("500 millis");
          yield* h.send({ version: 1, type: "usageLimitSourcesUpdated", payload: { sources: [] } });
          yield* TestClock.adjust("10 seconds");
        }),
      );
      expect(yield* Ref.get(attempts)).toEqual([CONFIG, CONFIG]);
    }),
  );

  it("only treats a legacy transport interruption as an unacknowledged handoff", () => {
    expect(isLegacyUpdateHandoffLoss(Cause.interrupt(1))).toBe(true);
    expect(
      isLegacyUpdateHandoffLoss(
        Cause.fail(
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        ),
      ),
    ).toBe(true);
    expect(
      isLegacyUpdateHandoffLoss(
        Cause.fail(
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketOpenError({
              kind: "Unknown",
              cause: new Error("connection refused"),
            }),
          }),
        ),
      ),
    ).toBe(false);
    expect(
      isLegacyUpdateHandoffLoss(
        Cause.fail(
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              message: "incompatible protocol",
              cause: new Error("invalid response"),
            }),
          }),
        ),
      ),
    ).toBe(false);
    expect(isLegacyUpdateHandoffLoss(Cause.fail(new Error("Install failed.")))).toBe(false);
  });

  it.effect("resumes after the progress stream disconnects following completion", () => {
    const result = {
      targetVersion: "0.0.31",
      method: "respawn" as const,
    };
    const disconnect = new RpcClientError.RpcClientError({
      reason: new Socket.SocketCloseError({ code: 1006 }),
    });

    return Effect.gen(function* () {
      const resumed = yield* resolveServerUpdateProgressResult(
        result.targetVersion,
        Option.some(result),
        Exit.fail(disconnect),
      );
      expect(resumed).toEqual(result);
    });
  });

  it("projects streamed update milestones into the shared operation state", () => {
    expect(
      serverUpdateStateForProgressEvent("0.0.30", "0.0.31", {
        type: "progress",
        stage: "installing",
      }),
    ).toEqual({
      status: "running",
      stage: "installing",
      fromVersion: "0.0.30",
      targetVersion: "0.0.31",
    });
    expect(
      serverUpdateStateForProgressEvent("0.0.30", "0.0.31", {
        type: "complete",
        result: { targetVersion: "0.0.31", method: "respawn" },
      }),
    ).toEqual({
      status: "running",
      stage: "resuming",
      fromVersion: "0.0.30",
      targetVersion: "0.0.31",
    });
    expect(
      serverUpdateStateForProgressEvent("0.0.30", "0.0.31", {
        type: "complete",
        result: { targetVersion: "0.0.31", method: "desktop-app", desktopUpdateToken: "token" },
      }).stage,
    ).toBe("installing");
  });

  it("keeps active update state and hides stale failures after a version change", () => {
    const running = {
      status: "running" as const,
      stage: "resuming" as const,
      fromVersion: "0.0.30",
      targetVersion: "0.0.31",
    };
    const failed = {
      status: "failed" as const,
      stage: "installing" as const,
      fromVersion: "0.0.30",
      targetVersion: "0.0.31",
      message: "Install failed.",
    };

    expect(serverUpdateStateForServerVersion(running, "0.0.31")).toBe(running);
    expect(serverUpdateStateForServerVersion(failed, "0.0.30")).toBe(failed);
    expect(serverUpdateStateForServerVersion(failed, null)).toBe(failed);
    expect(serverUpdateStateForServerVersion(failed, "0.0.31")).toEqual({ status: "idle" });
  });

  it.effect("correlates launcher outcomes and fails immediately after rollback", () =>
    Effect.gen(function* () {
      const result = {
        targetVersion: "0.0.31",
        method: "boot-service" as const,
        updateId: "update-1",
      };
      const ready = (status: "committed" | "rolled-back") =>
        ({
          version: 1 as const,
          sequence: 1,
          type: "ready" as const,
          payload: {
            at: "2026-08-01T00:00:00.000Z",
            environment: { serverVersion: status === "committed" ? "0.0.31" : "0.0.30" },
            updateOutcome: {
              id: "update-1",
              fromVersion: "0.0.30",
              targetVersion: "0.0.31",
              status,
              ...(status === "rolled-back" ? { reason: "prepared-timeout" } : {}),
            },
          },
        }) as Parameters<typeof matchesServerUpdateReadyEvent>[1];

      expect(matchesServerUpdateReadyEvent(result, ready("committed"))).toBe(true);
      yield* validateServerUpdateReadyEvent(result, ready("committed"));
      const rollback = yield* Effect.flip(
        validateServerUpdateReadyEvent(result, ready("rolled-back")),
      );
      expect(rollback.message).toBe("prepared-timeout");
    }),
  );

  it("requires tokenless desktop updates to reach the target version", () => {
    const ready = (serverVersion: string) =>
      ({
        version: 1 as const,
        sequence: 1,
        type: "ready" as const,
        payload: {
          at: "2026-09-01T00:00:00.000Z",
          environment: { serverVersion },
        },
      }) as Parameters<typeof matchesServerUpdateResumeEvent>[1];

    expect(
      matchesServerUpdateResumeEvent(
        { targetVersion: "0.0.31", method: "desktop-app" },
        ready("0.0.30"),
      ),
    ).toBe(false);
    expect(
      matchesServerUpdateResumeEvent(
        {
          targetVersion: "0.0.31",
          method: "desktop-app",
          desktopUpdateToken: "update-1",
        },
        ready("0.0.30"),
      ),
    ).toBe(true);
  });

  it("keeps published themes across a reconnect snapshot", () => {
    const themes = [
      {
        id: "nightfall",
        name: "Nightfall",
        appearance: "dark",
        canvas: "#1a1b26",
        accent: "#7aa2f7",
      },
    ] as const;

    const withThemes = applyServerConfigProjection(
      applyServerConfigProjection(Option.none(), { version: 1, type: "snapshot", config: CONFIG }),
      { version: 1, type: "environmentThemesUpdated", payload: { themes } },
    );
    expect(Option.getOrThrow(withThemes).config.environmentThemes).toEqual(themes);

    const afterReconnect = applyServerConfigProjection(withThemes, {
      version: 1,
      type: "snapshot",
      config: CONFIG,
    });
    expect(Option.getOrThrow(afterReconnect).config.environmentThemes).toEqual(themes);
  });

  it("keeps a current welcome on ready and rejects a buffered welcome from the old session", () => {
    const firstSession = session({} as WsRpcProtocolClient);
    const secondSession = session({} as WsRpcProtocolClient);
    const welcome = {
      environment: {} as ServerLifecycleWelcomePayload["environment"],
      cwd: "/repo",
      projectName: "repo",
    } as ServerLifecycleWelcomePayload;
    const initial = {
      currentSession: firstSession,
      welcomeSession: firstSession,
      welcome: null,
    };
    const afterWelcome = applyServerWelcomeEvent(initial, firstSession, {
      type: "welcome",
      payload: welcome,
    });
    const afterReady = applyServerWelcomeEvent(afterWelcome, firstSession, {
      type: "ready",
      payload: {},
    });
    const afterSwitch = { ...afterReady, currentSession: secondSession };
    const afterBufferedOldWelcome = applyServerWelcomeEvent(afterSwitch, firstSession, {
      type: "welcome",
      payload: { ...welcome, cwd: "/stale" },
    });

    expect(afterReady).toBe(afterWelcome);
    expect(resolveServerWelcomeState(afterReady)).toBe(welcome);
    expect(afterBufferedOldWelcome).toBe(afterSwitch);
    expect(resolveServerWelcomeState(afterBufferedOldWelcome)).toBeNull();
  });

  it.effect("checks the authoritative session before accepting a buffered welcome", () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<{
        readonly type: "welcome" | "ready";
        readonly payload: unknown;
      }>();
      const firstSubscribed = yield* Deferred.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(firstSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromQueue(firstEvents)),
          ),
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session({} as WsRpcProtocolClient);
      const supervisorSession = yield* SubscriptionRef.make(Option.some(firstSession));
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: supervisorSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const staleWelcome = {
        environment: {} as ServerLifecycleWelcomePayload["environment"],
        cwd: "/stale",
        projectName: "stale",
      } as ServerLifecycleWelcomePayload;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerWelcomeState().pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          );
          yield* Deferred.await(firstSubscribed);

          supervisorSession.value = Option.some(secondSession);
          const handled = yield* SubscriptionRef.changes(state).pipe(
            Stream.filter(
              (value) => value.currentSession === secondSession || value.welcome === staleWelcome,
            ),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
            Effect.forkChild,
          );
          yield* Queue.offer(firstEvents, { type: "welcome", payload: staleWelcome });

          const next = yield* Fiber.join(handled);
          expect(next.currentSession).toBe(secondSession);
          expect(resolveServerWelcomeState(next)).toBeNull();
        }),
      );
    }),
  );

  it.effect("reads the authoritative session after waiting for the welcome state lock", () =>
    Effect.gen(function* () {
      const firstSubscribed = yield* Deferred.make<void>();
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(firstSubscribed, undefined)).pipe(Stream.drain),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeServerLifecycle]: () => Stream.never,
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session(secondClient);
      const thirdSession = session({} as WsRpcProtocolClient);
      const supervisorSession = yield* SubscriptionRef.make(Option.some(firstSession));
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: supervisorSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerWelcomeState().pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          );
          yield* Deferred.await(firstSubscribed);
          const changed = yield* SubscriptionRef.changes(state).pipe(
            Stream.filter((value) => value.currentSession !== firstSession),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
            Effect.forkChild,
          );

          yield* state.semaphore.withPermit(
            Effect.gen(function* () {
              yield* SubscriptionRef.set(supervisorSession, Option.some(secondSession));
              yield* Effect.yieldNow;
              yield* Effect.yieldNow;
              yield* Effect.yieldNow;
              supervisorSession.value = Option.some(thirdSession);
            }),
          );

          expect((yield* Fiber.join(changed)).currentSession).toBe(thirdSession);
        }),
      );
    }),
  );

  it.effect("clears a welcome until the reconnected session sends its own", () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<{
        readonly type: "welcome" | "ready";
        readonly payload: unknown;
      }>();
      const secondEvents = yield* Queue.unbounded<{
        readonly type: "welcome" | "ready";
        readonly payload: unknown;
      }>();
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () => Stream.fromQueue(firstEvents),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeServerLifecycle]: () => Stream.fromQueue(secondEvents),
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session(secondClient);
      const supervisorSession = yield* SubscriptionRef.make(Option.some(firstSession));
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: supervisorSession,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const firstWelcome = {
        environment: {} as ServerLifecycleWelcomePayload["environment"],
        cwd: "/first",
        projectName: "first",
      } as ServerLifecycleWelcomePayload;
      const secondWelcome = {
        environment: {} as ServerLifecycleWelcomePayload["environment"],
        cwd: "/second",
        projectName: "second",
      } as ServerLifecycleWelcomePayload;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerWelcomeState().pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          );
          const nextResolved = (
            predicate: (value: ServerLifecycleWelcomePayload | null) => boolean,
          ) =>
            SubscriptionRef.changes(state).pipe(
              Stream.map(resolveServerWelcomeState),
              Stream.filter(predicate),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );

          const first = yield* nextResolved((value) => value === firstWelcome).pipe(
            Effect.forkChild,
          );
          yield* Queue.offer(firstEvents, { type: "welcome", payload: firstWelcome });
          expect(yield* Fiber.join(first)).toBe(firstWelcome);

          const cleared = yield* nextResolved((value) => value === null).pipe(Effect.forkChild);
          yield* SubscriptionRef.set(supervisorSession, Option.some(secondSession));
          expect(yield* Fiber.join(cleared)).toBeNull();
          expect(resolveServerWelcomeState(yield* SubscriptionRef.get(state))).toBeNull();

          const second = yield* nextResolved((value) => value === secondWelcome).pipe(
            Effect.forkChild,
          );
          yield* Queue.offer(secondEvents, { type: "welcome", payload: secondWelcome });
          expect(yield* Fiber.join(second)).toBe(secondWelcome);
        }),
      );
    }),
  );

  it("prefers an active session config over cache until a live event arrives", () => {
    const config = (source: string, serverVersion: string) =>
      ({
        ...CONFIG,
        environment: { serverVersion },
        settings: { source },
      }) as unknown as ServerConfig;
    const cached = config("cache", "0.0.29");
    const staleLive = config("stale-live", "0.0.29");
    const initial = config("session", "0.0.30");
    const live = config("live", "0.0.30");

    expect(
      resolveServerConfigValue(
        {
          config: cached,
          latestEvent: snapshotEvent(cached),
          source: "cache",
        },
        initial,
      ),
    ).toBe(initial);
    expect(
      resolveServerConfigValue(
        {
          config: staleLive,
          latestEvent: snapshotEvent(staleLive),
          source: "live",
        },
        initial,
      ),
    ).toBe(initial);
    expect(
      resolveServerConfigValue(
        {
          config: live,
          latestEvent: snapshotEvent(live),
          source: "live",
        },
        initial,
      ),
    ).toBe(live);
  });

  it("merges fetched workspace snapshots only from servers that omit them", () => {
    const claude = ProviderInstanceId.make("claudeAgent");
    const codex = ProviderInstanceId.make("codex");
    const snapshot = (cwd: string, command: string) => ({
      cwd,
      checkedAt: "2026-10-25T00:00:00.000Z",
      slashCommands: [{ name: command }],
      skills: [],
    });
    const provider = (
      instanceId: ProviderInstanceId,
      workspaceSnapshots?: ReadonlyArray<ReturnType<typeof snapshot>>,
      slashCommands: ReadonlyArray<{ readonly name: string }> = [],
    ) =>
      ({
        instanceId,
        enabled: true,
        slashCommands,
        skills: [],
        ...(workspaceSnapshots ? { workspaceSnapshots } : {}),
      }) as unknown as ServerConfig["providers"][number];
    const configWith = (onDemand: boolean, providers: ServerConfig["providers"]) =>
      ({
        ...CONFIG,
        environment: { capabilities: { providerWorkspaceSnapshotsOnDemand: onDemand } },
        providers,
      }) as unknown as ServerConfig;
    const claudeA = snapshot("/a", "claude");
    const record = (
      current: Parameters<typeof recordFetchedWorkspaceSnapshot>[0],
      instanceId: ProviderInstanceId,
      fresh: boolean,
      reply: ServerConfig["providers"],
    ) =>
      recordFetchedWorkspaceSnapshot(
        current,
        { instanceId, cwd: "/a", fresh },
        reply,
        provider(instanceId),
      );

    let fetched = record([], claude, false, [provider(claude, [claudeA])]);
    fetched = record(fetched, codex, false, [provider(codex, [snapshot("/a", "codex")])]);
    const merged = withFetchedWorkspaceSnapshots(
      configWith(true, [provider(claude), provider(codex)]),
      fetched,
    );
    expect(merged.providers[0]?.workspaceSnapshots).toEqual([claudeA]);
    // An unchanged answer keeps the cache, so config readers do not re-render.
    expect(
      record(fetched, claude, false, [
        provider(claude, [JSON.parse(JSON.stringify(claudeA)) as typeof claudeA]),
      ]),
    ).toBe(fetched);

    // Health checks and usage updates leave the snapshot in place.
    expect(
      withFetchedWorkspaceSnapshots(
        configWith(true, [
          { ...provider(claude), checkedAt: "2026-10-25T00:09:00.000Z", usageLimits: {} },
        ] as unknown as ServerConfig["providers"]),
        fetched,
      ).providers[0]?.workspaceSnapshots,
    ).toEqual([claudeA]);

    // New provider-wide commands, such as a live session's, retire the old snapshot.
    expect(
      withFetchedWorkspaceSnapshots(
        configWith(true, [provider(claude, undefined, [{ name: "live" }])]),
        fetched,
      ).providers[0]?.workspaceSnapshots,
    ).toBeUndefined();

    // Older servers send every snapshot and every drop; their config stands.
    const legacy = configWith(false, [provider(claude)]);
    expect(withFetchedWorkspaceSnapshots(legacy, fetched)).toBe(legacy);

    // A fresh scan drops the cwd's other provider snapshots, as the server does.
    expect(record(fetched, claude, true, [])).toEqual([]);
  });

  it.effect("starts from cached configuration and persists the live projection", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const savedConfigs = yield* Queue.unbounded<ServerConfig>();
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedNone,
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeedSome(CONFIG),
        saveServerConfig: (_environmentId, config) => Queue.offer(savedConfigs, config),
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerConfigState({}).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cache),
          );
          expect(Option.getOrThrow(yield* SubscriptionRef.get(state)).config).toBe(CONFIG);

          const providers: ServerConfig["providers"] = [];
          yield* Queue.offer(events, {
            version: 1,
            type: "providerStatuses",
            payload: { providers },
          });
          const projected = yield* SubscriptionRef.changes(state).pipe(
            Stream.filter((value) =>
              Option.match(value, {
                onNone: () => false,
                onSome: (projection) => projection.latestEvent.type === "providerStatuses",
              }),
            ),
            Stream.runHead,
          );
          expect(Option.getOrThrow(Option.getOrThrow(projected)).config.providers).toEqual(
            providers,
          );
        }),
      );

      expect((yield* Queue.take(savedConfigs)).providers).toEqual([]);
    }),
  );

  it.effect("shows a reported stall but never caches it", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const savedConfigs = yield* Queue.unbounded<ServerConfig>();
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedNone,
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeedSome(CONFIG),
        saveServerConfig: (_environmentId, config) => Queue.offer(savedConfigs, config),
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerConfigState({}).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cache),
          );
          expect(Option.getOrThrow(yield* SubscriptionRef.get(state)).config).toBe(CONFIG);

          const lastEventLoopStall = {
            detectedAt: "2026-10-20T07:50:37.633Z",
            durationMs: 12_422,
            loadAverage: 219.4,
            cpuCount: 18,
          };
          yield* Queue.offer(events, {
            version: 1,
            type: "snapshot",
            config: { ...CONFIG, lastEventLoopStall },
          });
          const projected = yield* SubscriptionRef.changes(state).pipe(
            Stream.filter((value) =>
              Option.match(value, {
                onNone: () => false,
                onSome: (projection) => projection.source === "live",
              }),
            ),
            Stream.runHead,
          );
          expect(Option.getOrThrow(Option.getOrThrow(projected)).config.lastEventLoopStall).toEqual(
            lastEventLoopStall,
          );
        }),
      );

      // Cached, it would read as a fresh freeze on the next launch.
      expect(yield* Queue.take(savedConfigs)).not.toHaveProperty("lastEventLoopStall");
    }),
  );
});
