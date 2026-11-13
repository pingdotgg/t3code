import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstallState,
  type ProviderSetupInput,
  ServerObservability,
  EnvironmentThemeId,
  UsageLimitSourceId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  describe,
  expect,
  it,
} from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import { AVAILABLE_CONNECTION_STATE, type PreparedConnection } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  applyServerWelcomeEvent,
  createServerEnvironmentAtoms,
  isLegacyUpdateHandoffLoss,
  matchesServerUpdateReadyEvent,
  matchesServerUpdateResumeEvent,
  resolveServerWelcomeState,
  resolveServerUpdateProgressResult,
  serverUpdateStateForProgressEvent,
  serverUpdateStateForServerVersion,
  validateServerUpdateReadyEvent,
} from "./server.ts";
import { applyServerConfigProjection } from "./serverConfigProjection.ts";
import {
  CONFIG,
  TARGET,
  makeConfigPersistenceHarness,
  session,
  snapshotEvent,
} from "./server.helpers2.testkit.ts";

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
});

describe("provider setup commands", () => {
  it.effect("starts installs for two instances in one environment separately", () =>
    Effect.gen(function* () {
      const requested = yield* Queue.unbounded<ProviderInstanceId>();
      const release = yield* Deferred.make<void>();
      const installState = (driver: string): ProviderInstallState => ({
        driver: ProviderDriverKind.make(driver),
        operationId: null,
        phase: "downloading",
        downloadedBytes: 0,
        totalBytes: null,
        version: null,
        installedVersion: null,
        canRemove: false,
        message: null,
      });
      const client = {
        [WS_METHODS.providerInstallStart]: ({ instanceId }: ProviderSetupInput) =>
          Queue.offer(requested, instanceId).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(installState(instanceId)),
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
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const runtime = Atom.runtime(
        Layer.merge(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
            run: (_environmentId, effect) =>
              Effect.provideService(
                effect,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
          } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
          Layer.succeed(
            Persistence.EnvironmentCacheStore,
            {} as Persistence.EnvironmentCacheStore["Service"],
          ),
        ),
      );
      const atoms = createServerEnvironmentAtoms(runtime, {
        initialConfigValueAtom: () => Atom.make(CONFIG),
      });
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const install = (instanceId: string) =>
        atoms.startProviderInstall.run(registry, {
          environmentId: TARGET.environmentId,
          input: { instanceId: ProviderInstanceId.make(instanceId) },
        });

      const codex = install("codex");
      expect(yield* Queue.take(requested)).toBe("codex");
      const duplicateCodex = install("codex");
      const antigravity = install("antigravity");
      yield* Deferred.succeed(release, undefined);

      expect(yield* Effect.promise(() => codex)).toMatchObject({
        _tag: "Success",
        value: { driver: "codex" },
      });
      expect(yield* Effect.promise(() => duplicateCodex)).toEqual(
        yield* Effect.promise(() => codex),
      );
      expect(yield* Effect.promise(() => antigravity)).toMatchObject({
        _tag: "Success",
        value: { driver: "antigravity" },
      });
      expect(yield* Queue.takeAll(requested)).toEqual(["antigravity"]);
    }).pipe(Effect.scoped),
  );
});
