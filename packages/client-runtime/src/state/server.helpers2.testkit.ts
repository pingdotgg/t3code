// @effect-diagnostics preferSchemaOverJson:off effectFnOpportunity:off
import {
  EnvironmentId,
  ProviderDriverKind,
  ServerSelfUpdateError,
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
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
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

export const CONFIG = {
  availableEditors: [],
  issues: [],
  keybindings: {},
  keybindingsConfigPath: null,
  observability: null,
  providers: [],
  settings: {},
  environment: { capabilities: { environmentThemes: true } },
} as unknown as ServerConfig;

export const snapshotEvent = (config: ServerConfig): ServerConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config,
});

export const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

export function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.succeed(CONFIG),
    subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

export const makeConfigPersistenceHarness = Effect.fn("test.makeConfigPersistenceHarness")(function* (
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
