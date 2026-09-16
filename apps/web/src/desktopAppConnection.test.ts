import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  type ConnectionCatalogEntry,
  EnvironmentNotRegisteredError,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import { ThreadSnapshotLoader } from "@t3tools/client-runtime/state/threads";
import {
  type DesktopAppConnectionRequest,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describe, it } from "@effect/vitest";
import * as Fiber from "effect/Fiber";
import { expect, vi } from "vite-plus/test";

import { handleDesktopAppConnectionRequest } from "./desktopAppConnection";

const localId = EnvironmentId.make("local");
const sshId = EnvironmentId.make("ssh-box");
const relayId = EnvironmentId.make("relay-box");
const threadId = ThreadId.make("thread-1");

const shellSnapshot = {
  snapshotSequence: 7,
  projects: [],
  threads: [],
} as unknown as OrchestrationShellSnapshot;
const threadSnapshot = (page?: OrchestrationThreadDetailSnapshot["page"]) =>
  ({
    snapshotSequence: 9,
    thread: { id: threadId },
    ...(page ? { page } : {}),
  }) as OrchestrationThreadDetailSnapshot;

interface EnvironmentFixture {
  readonly id: EnvironmentId;
  readonly target: PrimaryConnectionTarget | BearerConnectionTarget | RelayConnectionTarget;
  readonly phase?: SupervisorConnectionState["phase"];
  readonly client?: Partial<Record<string, (input: never) => unknown>>;
  readonly prepared?: PreparedConnection;
}

type Loader = ThreadSnapshotLoader["Service"]["load"];

const makeHarness = (
  fixtures: ReadonlyArray<EnvironmentFixture>,
  load: Loader = () => Effect.succeed(Option.none()),
) =>
  Effect.gen(function* () {
    const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
    const entries = new Map<EnvironmentId, ConnectionCatalogEntry>();
    const states = new Map<EnvironmentId, SupervisorConnectionState>();
    for (const fixture of fixtures) {
      const state = { ...AVAILABLE_CONNECTION_STATE, phase: fixture.phase ?? "connected" };
      states.set(fixture.id, state);
      entries.set(fixture.id, { target: fixture.target, profile: Option.none(), enabled: true });
      supervisors.set(
        fixture.id,
        EnvironmentSupervisor.of({
          target: fixture.target,
          state: yield* SubscriptionRef.make(state),
          session: yield* SubscriptionRef.make(
            Option.some({
              client: (fixture.client ?? {}) as unknown as WsRpcProtocolClient,
              initialConfig: Effect.succeed({ threadSnapshotPagination: true }),
            } as unknown as RpcSession),
          ),
          prepared: yield* SubscriptionRef.make(Option.fromNullishOr(fixture.prepared)),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        }),
      );
    }
    const notRegistered = (id: EnvironmentId) =>
      new EnvironmentNotRegisteredError({ environmentId: id });
    const partial: Pick<EnvironmentRegistry["Service"], "entries" | "state" | "run"> = {
      entries:
        yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(entries),
      state: (id) => {
        const state = states.get(id);
        return state === undefined ? Effect.fail(notRegistered(id)) : Effect.succeed(state);
      },
      run: (id, effect) => {
        const supervisor = supervisors.get(id);
        return supervisor === undefined
          ? Effect.fail(notRegistered(id))
          : Effect.provideService(effect, EnvironmentSupervisor, supervisor);
      },
    };
    const registry = EnvironmentRegistry.of(partial as EnvironmentRegistry["Service"]);
    const loader = ThreadSnapshotLoader.of({ load });
    return Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry, registry),
      Layer.succeed(ThreadSnapshotLoader, loader),
    );
  });

const primary = new PrimaryConnectionTarget({
  environmentId: localId,
  label: "This Mac",
  httpBaseUrl: "http://127.0.0.1:1",
  wsBaseUrl: "ws://127.0.0.1:1",
});
const ssh = new BearerConnectionTarget({
  environmentId: sshId,
  label: "SSH box",
  connectionId: "c1",
});
const relay = new RelayConnectionTarget({ environmentId: relayId, label: "Relay box" });

const shellRequest = (environmentId: EnvironmentId) =>
  ({
    version: 1,
    requestId: "r1",
    type: "connection",
    operation: "shell",
    environmentId,
  }) as const;

function run(
  request: DesktopAppConnectionRequest,
  fixtures: ReadonlyArray<EnvironmentFixture>,
  load?: Loader,
) {
  return makeHarness(fixtures, load).pipe(
    Effect.flatMap((layer) =>
      handleDesktopAppConnectionRequest(request).pipe(Effect.provide(layer)),
    ),
  );
}

describe("handleDesktopAppConnectionRequest", () => {
  it.effect("lists every registered environment with a coarse status", () =>
    Effect.gen(function* () {
      const response = yield* run(
        { version: 1, requestId: "r1", type: "connection", operation: "listEnvironments" },
        [
          { id: localId, target: primary },
          { id: sshId, target: ssh, phase: "connecting" },
          { id: relayId, target: relay, phase: "backoff" },
        ],
      );
      expect(response).toEqual({
        version: 1,
        requestId: "r1",
        ok: true,
        result: {
          environments: [
            { id: localId, label: "This Mac", status: "connected" },
            { id: sshId, label: "SSH box", status: "connecting" },
            { id: relayId, label: "Relay box", status: "disconnected" },
          ],
        },
      });
    }),
  );

  it.effect("routes each operation to the requested environment's own session", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const client = (name: string) => ({
        [ORCHESTRATION_WS_METHODS.subscribeShell]: () => {
          calls.push(`${name}:shell`);
          return Stream.make(
            { kind: "snapshot" as const, snapshot: shellSnapshot },
            { kind: "synchronized" as const },
          );
        },
        [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: () => {
          calls.push(`${name}:archived`);
          return Effect.succeed(shellSnapshot);
        },
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (input: unknown) => {
          calls.push(`${name}:dispatch:${(input as { type: string }).type}`);
          return Effect.succeed({ sequence: 3 });
        },
        [WS_METHODS.serverGetConfig]: () => {
          calls.push(`${name}:config`);
          return Effect.succeed({
            providers: [
              {
                instanceId: "codex",
                driver: "codex",
                displayName: "Codex",
                installed: true,
                enabled: true,
                status: "ready",
                auth: { status: "authenticated", email: "someone@example.com" },
                models: [],
                config: { apiKey: "secret" },
              },
            ],
          });
        },
      });
      const fixtures = [
        { id: localId, target: primary, client: client("local") },
        { id: relayId, target: relay, client: client("relay") },
      ];

      expect(yield* run(shellRequest(relayId), fixtures)).toMatchObject({
        ok: true,
        result: shellSnapshot,
      });
      expect(
        yield* run({ ...shellRequest(localId), operation: "archived" }, fixtures),
      ).toMatchObject({
        ok: true,
        result: shellSnapshot,
      });
      expect(
        yield* run(
          {
            ...shellRequest(relayId),
            operation: "dispatch",
            command: { type: "thread.archive", commandId: "c", threadId } as never,
          },
          fixtures,
        ),
      ).toMatchObject({ ok: true, result: { sequence: 3 } });
      const providers = yield* run({ ...shellRequest(localId), operation: "providers" }, fixtures);
      expect(providers).toEqual({
        version: 1,
        requestId: "r1",
        ok: true,
        result: {
          providers: [
            {
              instanceId: "codex",
              driver: "codex",
              displayName: "Codex",
              installed: true,
              enabled: true,
              status: "ready",
              authStatus: "authenticated",
              models: [],
            },
          ],
        },
      });
      expect(calls).toEqual([
        "relay:shell",
        "local:archived",
        "relay:dispatch:thread.archive",
        "local:config",
      ]);
    }),
  );

  it.effect("reads the newest thread window from the subscription and older pages over HTTP", () =>
    Effect.gen(function* () {
      const prepared = { httpBaseUrl: "https://relay.example" } as PreparedConnection;
      const load = vi.fn(() =>
        Effect.succeed(
          Option.some(threadSnapshot({ beforeCursor: null, hasMore: false, snapshotSequence: 9 })),
        ),
      );
      const subscribeThread = vi.fn((input: { turnLimit?: number }) =>
        Stream.make({
          kind: "snapshot" as const,
          snapshot: threadSnapshot(
            input.turnLimit
              ? { beforeCursor: "older", hasMore: true, snapshotSequence: 9 }
              : undefined,
          ),
        }),
      );
      const fixtures = [
        {
          id: relayId,
          target: relay,
          prepared,
          client: { [ORCHESTRATION_WS_METHODS.subscribeThread]: subscribeThread },
        },
      ];
      const base = {
        ...shellRequest(relayId),
        operation: "thread" as const,
        threadId,
        turnLimit: 5,
      };

      const newest = yield* run(base, fixtures, load);
      expect(newest).toMatchObject({ ok: true, result: { page: { beforeCursor: "older" } } });
      expect(subscribeThread).toHaveBeenCalledWith({ threadId, turnLimit: 5 });
      expect(load).not.toHaveBeenCalled();

      const older = yield* run({ ...base, beforeCursor: "older" }, fixtures, load);
      expect(older).toMatchObject({ ok: true, result: { page: { beforeCursor: null } } });
      expect(load).toHaveBeenCalledWith(prepared, threadId, {
        turnLimit: 5,
        beforeCursor: "older",
      });
      expect(subscribeThread).toHaveBeenCalledTimes(1);

      const missing: Loader = () => Effect.succeed(Option.none());
      expect(yield* run({ ...base, beforeCursor: "older" }, fixtures, missing)).toMatchObject({
        ok: false,
        code: "operation-failed",
      });
    }),
  );

  it.effect("reports unknown and disconnected environments distinctly", () =>
    Effect.gen(function* () {
      expect(
        yield* run(shellRequest(EnvironmentId.make("nope")), [{ id: localId, target: primary }]),
      ).toMatchObject({
        ok: false,
        code: "environment-not-found",
      });
      const older = {
        ...shellRequest(sshId),
        operation: "thread" as const,
        threadId,
        beforeCursor: "c",
      };
      expect(yield* run(older, [{ id: sshId, target: ssh }])).toMatchObject({
        ok: false,
        code: "environment-unavailable",
      });
    }),
  );

  it.effect("replaces upstream error text with a local message", () =>
    Effect.gen(function* () {
      const fixtures = [
        {
          id: sshId,
          target: ssh,
          client: {
            [ORCHESTRATION_WS_METHODS.dispatchCommand]: () =>
              Effect.fail({
                _tag: "OrchestrationDispatchCommandError",
                message: "token=abc host=10.0.0.5",
              }),
            [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: () =>
              Effect.fail({
                _tag: "RpcClientError",
                message: "https://user:pw@relay.example failed",
              }),
          },
        },
      ];
      const rejected = yield* run(
        {
          ...shellRequest(sshId),
          operation: "dispatch",
          command: { type: "thread.archive", commandId: "c", threadId } as never,
        },
        fixtures,
      );
      expect(rejected).toEqual({
        version: 1,
        requestId: "r1",
        ok: false,
        code: "operation-failed",
        message: "The environment rejected the command.",
      });
      const unknown = yield* run({ ...shellRequest(sshId), operation: "archived" }, fixtures);
      expect(unknown).toEqual({
        version: 1,
        requestId: "r1",
        ok: false,
        code: "operation-failed",
        message: "The environment rejected the request (RpcClientError).",
      });
    }),
  );

  it.effect("does not dispatch once the caller has been cancelled", () =>
    Effect.gen(function* () {
      const dispatched = vi.fn(() => Effect.succeed({ sequence: 1 }));
      const gate = yield* Deferred.make<void>();
      const fixtures = [
        {
          id: localId,
          target: primary,
          client: {
            [ORCHESTRATION_WS_METHODS.dispatchCommand]: () =>
              Deferred.await(gate).pipe(Effect.flatMap(() => dispatched())),
          },
        },
      ];
      const fiber = yield* Effect.forkChild(
        run(
          {
            ...shellRequest(localId),
            operation: "dispatch",
            command: { type: "thread.archive", commandId: "c", threadId } as never,
          },
          fixtures,
        ),
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      yield* Deferred.succeed(gate, undefined);
      yield* Effect.yieldNow;
      expect(dispatched).not.toHaveBeenCalled();
    }),
  );
});
