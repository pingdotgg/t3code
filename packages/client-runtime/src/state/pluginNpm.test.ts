import {
  EnvironmentId,
  PluginInstallationId,
  type PluginNpmListResult,
  type PluginNpmPackage,
  type ServerConfig,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
  createPluginNpmEnvironmentAtoms,
  listPluginNpmPackages,
  settlePluginNpmStep,
} from "./pluginNpm.ts";
import {
  resolvePluginNpmPackagesState,
  resolvePluginNpmProvenance,
  type PluginNpmStepMarker,
} from "./pluginNpmPresentation.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

/** A session to a server reporting `capabilities` that records each call it receives. */
const recordingSession = (
  capabilities: ServerConfig["environment"]["capabilities"],
  calls: Array<string>,
): RpcSession.RpcSession => ({
  client: new Proxy(
    {},
    {
      get: (_target, method: string) => () => {
        calls.push(method);
        return Effect.succeed({ packages: [] });
      },
    },
  ) as WsRpcProtocolClient,
  initialConfig: Effect.succeed({ environment: { capabilities } } as ServerConfig),
  subscribeServerConfig: () => Stream.never,
  ready: Effect.void,
  probe: Effect.void,
  closed: Effect.never,
});

const makeSupervisor = Effect.fn("makeSupervisor")(function* (
  session: RpcSession.RpcSession,
  state: SupervisorConnectionState = AVAILABLE_CONNECTION_STATE,
) {
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>(state),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
});

/** Runs every npm command against `session` and reports each result's failure tag. */
const runCommands = Effect.fn("runCommands")(function* (session: RpcSession.RpcSession) {
  const supervisor = yield* makeSupervisor(session);
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const atoms = createPluginNpmEnvironmentAtoms(
    Atom.runtime(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
        run,
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
    ),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  const environmentId = TARGET.environmentId;
  const installationId = PluginInstallationId.make("installation-1");
  const results = yield* Effect.forEach(
    [
      () =>
        atoms.add.run(registry, {
          environmentId,
          input: { name: "t3-plugin-hello", version: "1.0.0" },
        }),
      () =>
        atoms.stageUpdate.run(registry, {
          environmentId,
          input: { installationId, version: "latest" },
        }),
      () =>
        atoms.applyUpdate.run(registry, {
          environmentId,
          input: { installationId, digest: `sha256:${"0".repeat(64)}` },
        }),
      () => atoms.discardUpdate.run(registry, { environmentId, input: { installationId } }),
    ],
    (command) => Effect.promise(command),
  );
  const list = yield* listPluginNpmPackages.pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.exit,
  );
  return { results, list };
});

const failureTag = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  AsyncResult.isFailure(result)
    ? Option.getOrUndefined(Cause.findErrorOption(result.cause) as Option.Option<{ _tag: string }>)
        ?._tag
    : undefined;

describe("plugin npm commands", () => {
  it.effect("send nothing to a server that does not install from npm", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A server with the catalogue but not npm installs is still an older server here.
        for (const capabilities of [
          { repositoryIdentity: true },
          { repositoryIdentity: true, plugins: true },
          { repositoryIdentity: true, plugins: true, pluginNpm: false },
        ]) {
          const calls: Array<string> = [];
          const { results, list } = yield* runCommands(recordingSession(capabilities, calls));
          expect(results.map(failureTag)).toEqual(
            results.map(() => "EnvironmentRpcUnavailableError"),
          );
          expect(Exit.isFailure(list)).toBe(true);
          expect(calls).toEqual([]);
        }
      }),
    ),
  );

  it.effect("send each command to a server that announces npm installs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const { results, list } = yield* runCommands(
          recordingSession({ repositoryIdentity: true, plugins: true, pluginNpm: true }, calls),
        );
        expect(results.every(AsyncResult.isSuccess)).toBe(true);
        expect(Exit.isSuccess(list)).toBe(true);
        expect(calls).toEqual([
          WS_METHODS.pluginsNpmAdd,
          WS_METHODS.pluginsNpmStageUpdate,
          WS_METHODS.pluginsNpmApplyUpdate,
          WS_METHODS.pluginsNpmDiscardUpdate,
          WS_METHODS.pluginsNpmList,
        ]);
      }),
    ),
  );
});

const installationId = PluginInstallationId.make("installation-1");
const reply: PluginNpmPackage = {
  installationId,
  source: {
    registry: "https://registry.npmjs.org",
    name: "t3-notifier",
    version: "1.0.0",
    integrity: `sha512-${"A".repeat(86)}==`,
    installedAt: "2026-10-04T00:00:00.000Z",
  },
  stagedUpdate: null,
};

/**
 * The real npm list atom over a connected server whose list reads the test
 * answers one at a time; each read's Deferred is offered when it is sent.
 */
const makeListHarness = Effect.fn("makeListHarness")(function* () {
  const reads = yield* Queue.unbounded<Deferred.Deferred<PluginNpmListResult>>();
  const session: RpcSession.RpcSession = {
    client: new Proxy(
      {},
      {
        get: () => () =>
          Effect.gen(function* () {
            const read = yield* Deferred.make<PluginNpmListResult>();
            yield* Queue.offer(reads, read);
            return yield* Deferred.await(read);
          }),
      },
    ) as WsRpcProtocolClient,
    initialConfig: Effect.succeed({
      environment: { capabilities: { repositoryIdentity: true, plugins: true, pluginNpm: true } },
    } as ServerConfig),
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = yield* makeSupervisor(session, {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    phase: "connected",
  });
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const atoms = createPluginNpmEnvironmentAtoms(
    Atom.runtime(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
        run,
        followStream,
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
    ),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  const packages = atoms.packages({ environmentId: TARGET.environmentId, input: {} });
  yield* Effect.acquireRelease(
    Effect.sync(() => registry.mount(packages)),
    (unmount) => Effect.sync(unmount),
  );
  /** Answers a read and waits until the atom holds that exact list. */
  const answer = (read: Deferred.Deferred<PluginNpmListResult>, list: PluginNpmListResult) =>
    Deferred.succeed(read, list).pipe(
      Effect.andThen(
        AtomRegistry.toStream(registry, packages).pipe(
          Stream.filter((result) => AsyncResult.isSuccess(result) && result.value === list),
          Stream.runHead,
        ),
      ),
    );
  /** What a screen showing the current list would say about the installation. */
  const provenance = (step: PluginNpmStepMarker) => {
    const result = registry.get(packages);
    return resolvePluginNpmProvenance({
      state: resolvePluginNpmPackagesState({
        supported: true,
        data: AsyncResult.isSuccess(result) ? result.value : null,
        error: null,
      }),
      installationId,
      step,
    });
  };
  return { reads, registry, packages, answer, provenance };
});

describe("settlePluginNpmStep", () => {
  it.effect("keeps a reply over a list that arrived during the step, until a read after it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { reads, registry, packages, answer, provenance } = yield* makeListHarness();
        yield* answer(yield* Queue.take(reads), { packages: [] });
        // The step is running when the catalogue changes and the list is read again.
        registry.refresh(packages);
        yield* answer(yield* Queue.take(reads), { packages: [] });

        const step = settlePluginNpmStep(registry, packages, reply);
        expect(provenance(step)).toEqual({ _tag: "found", package: reply });
        yield* answer(yield* Queue.take(reads), { packages: [] });
        expect(provenance(step)).toEqual({ _tag: "none" });
      }),
    ),
  );

  it.effect("drops a read already running when the step settles", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { reads, registry, packages, answer, provenance } = yield* makeListHarness();
        yield* answer(yield* Queue.take(reads), { packages: [] });
        registry.refresh(packages);
        const before = yield* Queue.take(reads);

        // A failed step: nothing is known until a read after it.
        const step = settlePluginNpmStep(registry, packages, null);
        const after = yield* Queue.take(reads);
        yield* Deferred.succeed(before, { packages: [] });
        expect(provenance(step)).toEqual({ _tag: "checking" });
        yield* answer(after, { packages: [reply] });
        expect(provenance(step)).toEqual({ _tag: "found", package: reply });
      }),
    ),
  );
});
