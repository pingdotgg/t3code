import {
  EnvironmentId,
  PluginActionId,
  ProjectId,
  type PluginAction,
  type PluginActionsSnapshot,
  type ServerConfig,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import {
  createPluginActionEnvironmentAtoms,
  pluginActionLabels,
  pluginActionsAt,
  pluginActionsStream,
} from "./pluginActions.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const action = (
  name: string,
  target: PluginAction["target"],
  placements: PluginAction["placements"],
) =>
  ({
    id: PluginActionId.make(`installation-1:1:${name}`),
    pluginId: "test.actions",
    pluginName: "Actions",
    name,
    title: name,
    target,
    placements,
  }) satisfies PluginAction;

const ACTIONS = [
  action("everywhere", "environment", ["command-palette", "thread-menu"]),
  action("on-project", "project", ["command-palette"]),
  action("on-thread", "thread", ["command-palette", "composer-slash"]),
];

const ACTIONS_THEN_HOLD = Stream.succeed<PluginActionsSnapshot>({ actions: ACTIONS }).pipe(
  Stream.concat(Stream.never),
);

/** A session to a server reporting `capabilities` and sending `frames`, recording each call. */
const makeSession = (
  capabilities: ServerConfig["environment"]["capabilities"],
  calls: Array<string>,
  frames: Stream.Stream<PluginActionsSnapshot> = ACTIONS_THEN_HOLD,
): RpcSession.RpcSession => ({
  client: new Proxy(
    {},
    {
      get: (_target, method: string) => () => {
        calls.push(method);
        return method === WS_METHODS.pluginActionsSubscribe
          ? frames
          : Effect.succeed({ message: "done" });
      },
    },
  ) as WsRpcProtocolClient,
  initialConfig: Effect.succeed({ environment: { capabilities } } as ServerConfig),
  subscribeServerConfig: () => Stream.never,
  ready: Effect.void,
  probe: Effect.void,
  closed: Effect.never,
});

/**
 * One environment whose session reaches a server reporting `capabilities` and
 * sending `frames` to the subscription, recording each call.
 */
const makeEnvironment = Effect.fn("makeEnvironment")(function* (
  capabilities: ServerConfig["environment"]["capabilities"],
  frames: Stream.Stream<PluginActionsSnapshot> = ACTIONS_THEN_HOLD,
) {
  const calls: Array<string> = [];
  const sessionRef = yield* SubscriptionRef.make(
    Option.some(makeSession(capabilities, calls, frames)),
  );
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE),
    session: sessionRef,
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const atoms = createPluginActionEnvironmentAtoms(
    Atom.runtime(
      Layer.succeed(
        EnvironmentRegistry.EnvironmentRegistry,
        EnvironmentRegistry.EnvironmentRegistry.of({
          run,
          followStream: (_environmentId, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      ),
    ),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  const firstList = pluginActionsStream.pipe(
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  );
  const invoke = Effect.promise(() =>
    atoms.invoke.run(registry, {
      environmentId: TARGET.environmentId,
      input: { actionId: ACTIONS[0]!.id, target: { _tag: "environment" } },
    }),
  );
  const snapshots = AtomRegistry.toStreamResult(
    registry,
    atoms.snapshot({ environmentId: TARGET.environmentId, input: {} }),
  );
  return { calls, firstList, invoke, sessionRef, snapshots, supervisor };
});

const failureTag = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  AsyncResult.isFailure(result)
    ? Option.getOrUndefined(Cause.findErrorOption(result.cause) as Option.Option<{ _tag: string }>)
        ?._tag
    : undefined;

describe("plugin actions on an older server", () => {
  it.effect("offer nothing and send nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const capabilities of [
          { repositoryIdentity: true },
          { repositoryIdentity: true, plugins: true, pluginActions: false },
        ]) {
          const { calls, firstList, invoke } = yield* makeEnvironment(capabilities);
          expect(yield* firstList).toEqual({ actions: [] });
          expect(failureTag(yield* invoke)).toBe("EnvironmentRpcUnavailableError");
          expect(calls).toEqual([]);
        }
      }),
    ),
  );

  it.effect("are listed and run on a server that announces them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, firstList, invoke } = yield* makeEnvironment({
          repositoryIdentity: true,
          pluginActions: true,
        });
        expect(yield* firstList).toEqual({ actions: ACTIONS });
        const result = yield* invoke;
        expect(AsyncResult.isSuccess(result) && result.value).toEqual({ message: "done" });
        expect(calls).toEqual([WS_METHODS.pluginActionsSubscribe, WS_METHODS.pluginActionsInvoke]);
      }),
    ),
  );
});

describe("plugin actions across a reconnect", () => {
  it.effect("follow the server the environment is connected to now", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, invoke, sessionRef, supervisor } = yield* makeEnvironment({
          repositoryIdentity: true,
          pluginActions: true,
        });
        const lists = yield* Queue.unbounded<PluginActionsSnapshot>();
        yield* pluginActionsStream.pipe(
          Stream.runForEach((list) => Queue.offer(lists, list)),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkScoped,
        );
        expect(yield* Queue.take(lists)).toEqual({ actions: ACTIONS });

        // The environment reconnects to an older server: its actions disappear
        // and a pick made from the old list is not sent there.
        const oldCalls: Array<string> = [];
        yield* SubscriptionRef.set(
          sessionRef,
          Option.some(makeSession({ repositoryIdentity: true }, oldCalls)),
        );
        expect(yield* Queue.take(lists)).toEqual({ actions: [] });
        expect(failureTag(yield* invoke)).toBe("EnvironmentRpcUnavailableError");
        expect(oldCalls).toEqual([]);

        // Back on a server with plugin actions, the list returns.
        const newCalls: Array<string> = [];
        yield* SubscriptionRef.set(
          sessionRef,
          Option.some(makeSession({ repositoryIdentity: true, pluginActions: true }, newCalls)),
        );
        expect(yield* Queue.take(lists)).toEqual({ actions: ACTIONS });
        expect(calls).toEqual([WS_METHODS.pluginActionsSubscribe]);
        expect(newCalls).toEqual([WS_METHODS.pluginActionsSubscribe]);
      }),
    ),
  );
});

describe("the plugin actions snapshot", () => {
  it.effect("keeps what the server's limit left out until room is freed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const frames = yield* Queue.unbounded<PluginActionsSnapshot>();
        const { snapshots } = yield* makeEnvironment(
          { repositoryIdentity: true, pluginActions: true },
          Stream.fromQueue(frames),
        );
        const seen = yield* Queue.unbounded<PluginActionsSnapshot>();
        yield* snapshots.pipe(
          Stream.runForEach((snapshot) => Queue.offer(seen, snapshot)),
          Effect.forkScoped,
        );

        yield* Queue.offer(frames, { actions: ACTIONS, omitted: { plugins: 1, actions: 16 } });
        expect(yield* Queue.take(seen)).toEqual({
          actions: ACTIONS,
          omitted: { plugins: 1, actions: 16 },
        });

        // Disabling a listed plugin admits the next whole; the server stops reporting omissions.
        const promoted = [...ACTIONS, action("promoted", "environment", ["thread-menu"])];
        yield* Queue.offer(frames, { actions: promoted });
        const freed = yield* Queue.take(seen);
        expect(freed).toEqual({ actions: promoted });
        expect(freed.omitted).toBeUndefined();
      }),
    ),
  );
});

describe("pluginActionsAt", () => {
  const names = (entries: ReturnType<typeof pluginActionsAt>) =>
    entries.map(({ action, target }) => [action.name, target._tag]);

  it("offers an action only where it is placed and its target is known", () => {
    const threadId = ThreadId.make("thread-1");
    const projectId = ProjectId.make("project-1");
    expect(names(pluginActionsAt(ACTIONS, "command-palette", { threadId, projectId }))).toEqual([
      ["everywhere", "environment"],
      ["on-project", "project"],
      ["on-thread", "thread"],
    ]);
    // A palette opened outside any thread or project.
    expect(
      names(pluginActionsAt(ACTIONS, "command-palette", { threadId: null, projectId: null })),
    ).toEqual([["everywhere", "environment"]]);
    expect(names(pluginActionsAt(ACTIONS, "thread-menu", { threadId, projectId }))).toEqual([
      ["everywhere", "environment"],
    ]);
    expect(
      names(pluginActionsAt(ACTIONS, "composer-slash", { threadId: null, projectId })),
    ).toEqual([]);
  });
});

describe("pluginActionLabels", () => {
  it("names the plugin only when two actions share a title", () => {
    const deploy = { ...action("deploy", "environment", ["thread-menu"]), title: "Deploy" };
    expect(
      pluginActionLabels([
        deploy,
        { ...deploy, id: PluginActionId.make("installation-2:1:deploy"), pluginName: "Other" },
        ACTIONS[0]!,
      ]),
    ).toEqual(["Deploy (Actions)", "Deploy (Other)", "everywhere"]);
  });
});
