import {
  EnvironmentId,
  type OrchestrationThreadShell,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  WS_METHODS,
} from "@t3tools/contracts";
import { isAutomaticServerUpdateThreadActive } from "@t3tools/shared/automaticServerUpdate";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  applyServerConfigProjection,
  automaticServerUpdateDecision,
  makeEnvironmentServerConfigState,
  isLegacyUpdateHandoffLoss,
  matchesServerUpdateReadyEvent,
  nudgeReconnectDuringUpdateRestart,
  projectServerWelcome,
  resolveServerConfigValue,
  resolveServerUpdateProgressResult,
  serverUpdateStateForAutomaticDecision,
  serverUpdateStateForProgressEvent,
  serverUpdateStateForServerVersion,
  validateServerUpdateReadyEvent,
} from "./server.ts";

type ActivityThread = Pick<
  OrchestrationThreadShell,
  "session" | "latestTurn" | "backgroundLiveness"
>;

const IDLE_THREAD: ActivityThread = {
  session: null,
  latestTurn: null,
  backgroundLiveness: null,
};

describe("automatic server update decisions", () => {
  it("only targets a semver-newer client on launcher-managed opted-in servers", () => {
    const eligible = {
      enabled: true,
      selfUpdate: "boot-service" as const,
      clientVersion: "1.3.0",
      serverVersion: "1.2.0",
      shellStatus: "live" as const,
      threads: [IDLE_THREAD],
    };

    expect(automaticServerUpdateDecision(eligible)).toEqual({
      status: "ready",
      fromVersion: "1.2.0",
      targetVersion: "1.3.0",
    });
    expect(automaticServerUpdateDecision({ ...eligible, enabled: false })).toEqual({
      status: "ineligible",
    });
    expect(automaticServerUpdateDecision({ ...eligible, selfUpdate: "desktop-managed" })).toEqual({
      status: "ineligible",
    });
    expect(automaticServerUpdateDecision({ ...eligible, selfUpdate: "respawn" })).toEqual({
      status: "ineligible",
    });
    expect(automaticServerUpdateDecision({ ...eligible, selfUpdate: null })).toEqual({
      status: "ineligible",
    });
    expect(
      automaticServerUpdateDecision({
        ...eligible,
        clientVersion: "1.2.0",
        serverVersion: "1.3.0",
      }),
    ).toEqual({ status: "ineligible" });
    expect(
      automaticServerUpdateDecision({ ...eligible, clientVersion: "dev", serverVersion: "1.2.0" }),
    ).toEqual({ status: "ineligible" });
  });

  it("waits for a live shell and every active-work signal to clear", () => {
    const input = {
      enabled: true,
      selfUpdate: "boot-service" as const,
      clientVersion: "1.3.0",
      serverVersion: "1.2.0",
      shellStatus: "live" as const,
      threads: [IDLE_THREAD],
    };
    const activeSession = {
      status: "ready" as const,
      activeTurnId: "turn-1",
    } as ActivityThread["session"];
    const runningTurn = { state: "running" as const } as ActivityThread["latestTurn"];

    expect(automaticServerUpdateDecision({ ...input, shellStatus: "cached" })).toEqual({
      status: "pending",
      reason: "synchronizing",
      fromVersion: "1.2.0",
      targetVersion: "1.3.0",
    });

    for (const thread of [
      { ...IDLE_THREAD, session: { ...activeSession, status: "starting" } },
      { ...IDLE_THREAD, session: { ...activeSession, status: "running" } },
      { ...IDLE_THREAD, session: activeSession },
      { ...IDLE_THREAD, latestTurn: runningTurn },
      { ...IDLE_THREAD, backgroundLiveness: "working" as const },
      { ...IDLE_THREAD, backgroundLiveness: "monitoring" as const },
    ]) {
      expect(isAutomaticServerUpdateThreadActive(thread)).toBe(true);
      expect(automaticServerUpdateDecision({ ...input, threads: [thread] })).toEqual({
        status: "pending",
        reason: "active-work",
        fromVersion: "1.2.0",
        targetVersion: "1.3.0",
      });
    }

    expect(isAutomaticServerUpdateThreadActive(IDLE_THREAD)).toBe(false);
  });
});

const CONFIG = {
  availableEditors: [],
  issues: [],
  keybindings: {},
  keybindingsConfigPath: null,
  observability: null,
  providers: [],
  settings: {},
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
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

describe("update restart reconnect nudges", () => {
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

      // Three backoff entries, three nudges. The old one-shot behavior fired
      // once and then let the supervisor's ladder stretch to 16-second gaps.
      expect(yield* Ref.get(retries)).toBe(3);
    }),
  );

  it.effect("paces nudges so a fast-failing connection cannot spin", () =>
    Effect.gen(function* () {
      const retries = yield* Ref.make(0);

      const fiber = yield* Effect.forkChild(
        nudgeReconnectDuringUpdateRestart({
          stateChanges: Stream.fromIterable([{ phase: "backoff" }, { phase: "backoff" }]),
          retryNow: Ref.update(retries, (count) => count + 1),
        }),
        { startImmediately: true },
      );

      // Each nudge waits out the interval first, so nothing fires immediately.
      yield* TestClock.adjust(Duration.millis(999));
      expect(yield* Ref.get(retries)).toBe(0);

      yield* TestClock.adjust(Duration.millis(1));
      expect(yield* Ref.get(retries)).toBe(1);

      yield* TestClock.adjust(Duration.seconds(1));
      expect(yield* Ref.get(retries)).toBe(2);

      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("server state projection", () => {
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

  it("projects automatic waits without overwriting active or failed operations", () => {
    const pending = {
      status: "pending" as const,
      reason: "active-work" as const,
      fromVersion: "0.0.30",
      targetVersion: "0.0.31",
    };
    const running = {
      status: "running" as const,
      stage: "downloading" as const,
      fromVersion: "0.0.30",
      targetVersion: "0.0.31",
    };
    const failed = {
      status: "failed" as const,
      stage: "downloading" as const,
      fromVersion: "0.0.30",
      targetVersion: "0.0.31",
      message: "Nope",
    };

    expect(serverUpdateStateForAutomaticDecision({ status: "idle" }, pending)).toEqual(pending);
    expect(serverUpdateStateForAutomaticDecision(pending, null)).toEqual({ status: "idle" });
    expect(serverUpdateStateForAutomaticDecision(running, pending)).toBe(running);
    expect(serverUpdateStateForAutomaticDecision(failed, pending)).toBe(failed);
    expect(
      serverUpdateStateForAutomaticDecision(failed, {
        ...pending,
        targetVersion: "0.0.32",
      }),
    ).toEqual({ ...pending, targetVersion: "0.0.32" });
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

  it("applies every config category to the projected snapshot", () => {
    const snapshot = applyServerConfigProjection(Option.none(), {
      version: 1,
      type: "snapshot",
      config: CONFIG,
    });
    const settings = { ...CONFIG.settings };
    const projected = applyServerConfigProjection(snapshot, {
      version: 1,
      type: "settingsUpdated",
      payload: { settings },
    });

    const result = Option.getOrThrow(projected);
    expect(result.config.settings).toBe(settings);
    expect(result.latestEvent.type).toBe("settingsUpdated");
  });

  it("retains welcome when a ready event follows in the same stream chunk", () => {
    const welcome = {
      environment: {} as ServerLifecycleWelcomePayload["environment"],
      cwd: "/repo",
      projectName: "repo",
    } as ServerLifecycleWelcomePayload;
    const [afterWelcome] = projectServerWelcome(Option.none(), {
      type: "welcome",
      payload: welcome,
    });
    const [afterReady, emitted] = projectServerWelcome(afterWelcome, {
      type: "ready",
      payload: {},
    });

    expect(Option.getOrThrow(afterReady)).toBe(welcome);
    expect(emitted).toEqual([]);
  });

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
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.some(CONFIG)),
        saveServerConfig: (_environmentId, config) => Queue.offer(savedConfigs, config),
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerConfigState().pipe(
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
          expect(Option.getOrThrow(Option.getOrThrow(projected)).config.providers).toBe(providers);
        }),
      );

      expect((yield* Queue.take(savedConfigs)).providers).toEqual([]);
    }),
  );

  it.effect("does not rewrite cached configuration when no live update arrives", () =>
    Effect.gen(function* () {
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => Stream.empty,
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
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.some(CONFIG)),
        saveServerConfig: (_environmentId, config) => Queue.offer(savedConfigs, config),
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });

      yield* Effect.scoped(
        makeEnvironmentServerConfigState().pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        ),
      );

      expect(yield* Queue.poll(savedConfigs)).toEqual(Option.none());
    }),
  );
});
