import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type AgentctlSandboxesSnapshot,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../config.ts";
import * as AgentctlCli from "./AgentctlCli.ts";
import * as AgentctlSandboxes from "./AgentctlSandboxes.ts";
import * as AgentctlSandboxTunnels from "./AgentctlSandboxTunnels.ts";
import type { AgentResource } from "./agentState.ts";

const NAME = "worker";
const isAgentctlError = Schema.is(AgentctlCli.AgentctlError);

function agent(phase: "ready" | "stopped" | "retrying"): AgentResource {
  const conditions =
    phase === "ready"
      ? [
          { type: "Ready", status: "True", reason: "SandboxReady" },
          { type: "SshReady", status: "True", reason: "ServerRunning" },
        ]
      : phase === "stopped"
        ? [{ type: "Ready", status: "False", reason: "Stopped" }]
        : [{ type: "Ready", status: "False", reason: "SandboxReconcileFailed" }];
  return {
    metadata: { name: NAME, generation: 1 },
    spec: { access: [{ type: "ssh" }], ...(phase === "stopped" ? { runState: "Stopped" } : {}) },
    status: {
      observedGeneration: 1,
      conditions,
      ...(phase === "retrying" ? { failure: "transient" } : {}),
    },
  };
}

interface Harness {
  readonly agents: Ref.Ref<ReadonlyArray<AgentResource>>;
  readonly listFails: Ref.Ref<boolean>;
  readonly ensured: Ref.Ref<number>;
  /** Each time T3 opens the forward to the Sandbox. */
  readonly ensures: Queue.Queue<void>;
  /** What the Sandbox's T3 server reports; plain, because fetch reads it. */
  readonly environment: { id: string };
  readonly disconnected: Deferred.Deferred<void>;
  /**
   * While set, each check hands its gate to `heldChecks` once it has the environment id, and
   * waits for it.
   */
  readonly holdChecks: Ref.Ref<boolean>;
  readonly heldChecks: Queue.Queue<Deferred.Deferred<void>>;
  /** The next SSH reach fails, like a Sandbox still booting. */
  readonly ensureFails: Ref.Ref<boolean>;
  /**
   * While set, each start hands its gate to `heldStarts`, then waits for it and
   * fails, like a start a stop cut short.
   */
  readonly holdStarts: Ref.Ref<boolean>;
  readonly heldStarts: Queue.Queue<Deferred.Deferred<void>>;
  readonly applyFails: Ref.Ref<boolean>;
  /** Each `get agents` read. */
  readonly lists: Queue.Queue<void>;
  /** What `get agents --watch` prints; without it, this agentctl predates `--watch`. */
  readonly watch: Queue.Queue<AgentctlCli.AgentctlWatchEvent | AgentctlCli.AgentctlError> | null;
  readonly watchStarts: Queue.Queue<void>;
}

const makeHarness = (options?: { readonly watch?: boolean }) =>
  Effect.gen(function* () {
    return {
      agents: yield* Ref.make<ReadonlyArray<AgentResource>>([agent("ready")]),
      listFails: yield* Ref.make(false),
      ensured: yield* Ref.make(0),
      ensures: yield* Queue.unbounded<void>(),
      environment: { id: "env-1" },
      disconnected: yield* Deferred.make<void>(),
      ensureFails: yield* Ref.make(false),
      holdChecks: yield* Ref.make(false),
      heldChecks: yield* Queue.unbounded<Deferred.Deferred<void>>(),
      holdStarts: yield* Ref.make(false),
      heldStarts: yield* Queue.unbounded<Deferred.Deferred<void>>(),
      applyFails: yield* Ref.make(false),
      lists: yield* Queue.unbounded<void>(),
      watch:
        options?.watch === true
          ? yield* Queue.unbounded<AgentctlCli.AgentctlWatchEvent | AgentctlCli.AgentctlError>()
          : null,
      watchStarts: yield* Queue.unbounded<void>(),
    } satisfies Harness;
  });

const configLayer = (baseDir: string) =>
  ServerConfig.ServerConfig.layerTest(baseDir, baseDir).pipe(Layer.provide(NodeServices.layer));

function layer(harness: Harness, baseDir: string) {
  const cli = AgentctlCli.AgentctlCli.of({
    listAgents: Queue.offer(harness.lists, undefined).pipe(
      Effect.andThen(Ref.get(harness.listFails)),
      Effect.flatMap((fails) =>
        fails
          ? Effect.fail(
              new AgentctlCli.AgentctlError({
                command: "get",
                reason: "failed",
                reported: "agentd is restarting",
              }),
            )
          : Ref.get(harness.agents),
      ),
    ),
    watchAgents: Stream.unwrap(
      Effect.gen(function* () {
        const watch = harness.watch;
        if (watch === null) {
          return Stream.fail(
            new AgentctlCli.AgentctlError({ command: "get --watch", reason: "unsupported" }),
          );
        }
        yield* Queue.offer(harness.watchStarts, undefined);
        return Stream.fromQueue(watch).pipe(
          Stream.mapEffect((item) =>
            isAgentctlError(item) ? Effect.fail(item) : Effect.succeed(item),
          ),
        );
      }),
    ),
    // Runs after the check fetched the environment id.
    sshInfo: () =>
      Ref.get(harness.holdChecks).pipe(
        Effect.flatMap((hold) =>
          hold
            ? Effect.gen(function* () {
                const gate = yield* Deferred.make<void>();
                yield* Queue.offer(harness.heldChecks, gate);
                yield* Deferred.await(gate);
              })
            : Effect.void,
        ),
        Effect.as({ workingDirectory: "/home/agent/code" }),
      ),
    start: () =>
      Ref.get(harness.holdStarts).pipe(
        Effect.flatMap((hold) =>
          hold
            ? Effect.gen(function* () {
                const gate = yield* Deferred.make<void>();
                yield* Queue.offer(harness.heldStarts, gate);
                yield* Deferred.await(gate);
                return yield* new AgentctlCli.AgentctlError({
                  command: "start",
                  reason: "failed",
                  reported: "Agent was stopped",
                });
              })
            : Ref.set(harness.agents, [agent("ready")]),
        ),
      ),
    stop: () => Ref.set(harness.agents, [agent("stopped")]),
    remove: () => Ref.set(harness.agents, []),
    apply: () =>
      Ref.get(harness.applyFails).pipe(
        Effect.flatMap((fails) =>
          fails
            ? Effect.fail(
                new AgentctlCli.AgentctlError({
                  command: "apply",
                  reason: "failed",
                  reported: "invalid manifest",
                }),
              )
            : Ref.set(harness.agents, [agent("retrying")]),
        ),
      ),
  });
  const target: DesktopSshEnvironmentTarget = {
    alias: `agentctl-${NAME}`,
    hostname: `agentctl-${NAME}`,
    username: "agent",
    port: 22,
  };
  const tunnels = AgentctlSandboxTunnels.AgentctlSandboxTunnels.of({
    ensure: (_target, options) =>
      Ref.update(harness.ensured, (count) => count + 1).pipe(
        Effect.andThen(Queue.offer(harness.ensures, undefined)),

        Effect.andThen(Ref.getAndSet(harness.ensureFails, false)),
        Effect.flatMap((fails) =>
          fails
            ? Effect.fail(
                new AgentctlSandboxTunnels.SandboxTunnelError({ message: "Sandbox still booting" }),
              )
            : Effect.void,
        ),
        Effect.as({
          target,
          httpBaseUrl: "http://127.0.0.1:4010/",
          pairingToken: options?.issuePairingToken === true ? "pairing-code" : null,
        }),
      ),
    // Stopping T3's server over SSH hangs while a Sandbox stops; nothing may wait for it.
    disconnect: () =>
      Deferred.succeed(harness.disconnected, undefined).pipe(Effect.andThen(Effect.never)),
  });
  const fetchDescriptor: typeof globalThis.fetch = () =>
    Promise.resolve(
      Response.json({
        environmentId: harness.environment.id,
        label: NAME,
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        orchestrationProtocolVersion: 2,
        capabilities: { repositoryIdentity: true },
      }),
    );
  return Layer.effect(AgentctlSandboxes.AgentctlSandboxes, AgentctlSandboxes.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentctlCli.AgentctlCli, cli),
        Layer.succeed(AgentctlSandboxTunnels.AgentctlSandboxTunnels, tunnels),
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchDescriptor)),
        ),
        configLayer(baseDir),
        NodeServices.layer,
      ),
    ),
  );
}

const withSandboxes = <A, E>(
  test: (
    sandboxes: AgentctlSandboxes.AgentctlSandboxes["Service"],
    harness: Harness,
    stateDir: string,
  ) => Effect.Effect<A, E>,
  prepare?: (
    stateDir: string,
  ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>,
  options?: { readonly watch?: boolean },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agentctl-test-" });
    const harness = yield* makeHarness(options);
    const stateDir = yield* Effect.provide(
      Effect.map(ServerConfig.ServerConfig, (config) => config.stateDir),
      configLayer(baseDir),
    );
    if (prepare) yield* prepare(stateDir);
    return yield* Effect.gen(function* () {
      const sandboxes = yield* AgentctlSandboxes.AgentctlSandboxes;
      yield* sandboxes.startWatching;
      return yield* test(sandboxes, harness, stateDir);
    }).pipe(Effect.provide(layer(harness, baseDir)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

/** Waits for the snapshot to reach a state; the stream replays the current one first. */
const until = (
  sandboxes: AgentctlSandboxes.AgentctlSandboxes["Service"],
  predicate: (snapshot: AgentctlSandboxesSnapshot) => boolean,
) =>
  sandboxes.changes.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));

const discovered = (environmentId: string) => (snapshot: AgentctlSandboxesSnapshot) =>
  snapshot.sandboxes[0]?.environmentId === environmentId;

const watchedAgents = (agents: ReadonlyArray<AgentResource>): AgentctlCli.AgentctlWatchEvent => ({
  _tag: "Agents",
  agents,
});

describe("AgentctlSandboxes", () => {
  it.effect("follows the Agents agentctl watches instead of polling", () =>
    withSandboxes(
      (sandboxes, harness) =>
        Effect.gen(function* () {
          const watch = harness.watch!;
          yield* Queue.take(harness.watchStarts);
          yield* Queue.offer(watch, watchedAgents([agent("ready")]));
          yield* until(sandboxes, discovered("env-1"));
          yield* Queue.offer(watch, watchedAgents([agent("stopped")]));
          yield* until(sandboxes, (snapshot) => snapshot.sandboxes[0]?.phase === "stopped");
          yield* TestClock.adjust("1 minute");
          assert.isTrue(Option.isNone(yield* Queue.poll(harness.lists)));
        }),
      undefined,
      { watch: true },
    ),
  );

  it.effect("reads agentctl, which starts agentd, when its watch reports trouble", () =>
    withSandboxes(
      (sandboxes, harness) =>
        Effect.gen(function* () {
          const watch = harness.watch!;
          yield* Queue.take(harness.watchStarts);
          yield* Queue.offer(watch, watchedAgents([agent("ready")]));
          yield* until(sandboxes, discovered("env-1"));
          yield* Ref.set(harness.listFails, true);
          yield* Queue.offer(watch, { _tag: "Trouble", message: "watch failed, retrying" });
          yield* Queue.take(harness.lists);
          const snapshot = yield* until(sandboxes, (current) => current.error !== null);
          assert.strictEqual(snapshot.sandboxes[0]?.environmentId, "env-1");
          // It keeps reading until agentd answers, and then clears the error, though the
          // recovered watch prints nothing for an unchanged list.
          yield* TestClock.adjust("3 seconds");
          yield* Queue.take(harness.lists);
          yield* Ref.set(harness.listFails, false);
          yield* TestClock.adjust("3 seconds");
          yield* Queue.take(harness.lists);
          yield* until(sandboxes, (current) => current.error === null);
        }),
      undefined,
      { watch: true },
    ),
  );

  it.effect("watches again after agentctl ends its watch", () =>
    withSandboxes(
      (sandboxes, harness) =>
        Effect.gen(function* () {
          const watch = harness.watch!;
          yield* Queue.take(harness.watchStarts);
          yield* Queue.offer(watch, watchedAgents([agent("ready")]));
          yield* until(sandboxes, discovered("env-1"));
          // As after an agentd upgrade, which the new agentctl watches.
          yield* Queue.offer(
            watch,
            new AgentctlCli.AgentctlError({
              command: "get",
              reason: "failed",
              reported: "agentd is incompatible",
            }),
          );
          yield* Queue.take(harness.lists);
          yield* TestClock.adjust("3 seconds");
          yield* Queue.take(harness.watchStarts);
        }),
      undefined,
      { watch: true },
    ),
  );

  it.effect("reaches a running Sandbox once and records its environment", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        const snapshot = yield* until(sandboxes, discovered("env-1"));
        assert.strictEqual(snapshot.sandboxes[0]?.workingDirectory, "/home/agent/code");
        yield* sandboxes.refresh;
        yield* sandboxes.refresh;
        assert.strictEqual(yield* Ref.get(harness.ensured), 1);
      }),
    ),
  );

  it.effect("relays and pairs only a Sandbox that is running", () =>
    withSandboxes((sandboxes) =>
      Effect.gen(function* () {
        yield* until(sandboxes, discovered("env-1"));
        assert.deepStrictEqual(
          yield* sandboxes.relayUpstream(NAME),
          Option.some("http://127.0.0.1:4010/"),
        );
        assert.deepStrictEqual(yield* sandboxes.pair(NAME), {
          environmentId: EnvironmentId.make("env-1"),
          pairingToken: "pairing-code",
        });
        assert.strictEqual((yield* Effect.flip(sandboxes.pair("other"))).reason, "not-found");

        yield* sandboxes.stop(NAME);
        assert.deepStrictEqual(yield* sandboxes.relayUpstream(NAME), Option.none());
        assert.strictEqual((yield* Effect.flip(sandboxes.pair(NAME))).reason, "not-running");
      }),
    ),
  );

  it.effect("opens the forward again once the relay could not reach it", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* until(sandboxes, discovered("env-1"));
        yield* Queue.take(harness.ensures);
        yield* sandboxes.reportUnreachable(NAME);
        assert.deepStrictEqual(yield* sandboxes.relayUpstream(NAME), Option.none());
        yield* sandboxes.refresh;
        yield* Queue.take(harness.ensures);
      }),
    ),
  );

  it.effect("ignores a check that ends after the Sandbox stopped", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* until(sandboxes, discovered("env-1"));
        yield* sandboxes.stop(NAME);
        yield* sandboxes.refresh;
        yield* Ref.set(harness.holdChecks, true);
        yield* sandboxes.start(NAME);
        // This check learned env-1, then the Sandbox stopped and its T3 home was reset.
        const stale = yield* Queue.take(harness.heldChecks);
        yield* sandboxes.stop(NAME);
        yield* sandboxes.refresh;
        harness.environment.id = "env-2";
        yield* sandboxes.start(NAME);
        yield* Deferred.succeed(yield* Queue.take(harness.heldChecks), undefined);
        yield* until(sandboxes, discovered("env-2"));
        yield* Deferred.succeed(stale, undefined);
        yield* sandboxes.refresh;
        assert.strictEqual((yield* sandboxes.snapshot).sandboxes[0]?.environmentId, "env-2");
      }),
    ),
  );

  it.effect("ignores a check of a deleted Sandbox once another takes its name", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* until(sandboxes, discovered("env-1"));
        yield* sandboxes.stop(NAME);
        yield* sandboxes.refresh;
        yield* Ref.set(harness.holdChecks, true);
        yield* sandboxes.start(NAME);
        const stale = yield* Queue.take(harness.heldChecks);
        yield* sandboxes.remove(NAME);
        // A new Sandbox of the same name, stopped and started as often as the deleted one.
        harness.environment.id = "env-2";
        yield* Ref.set(harness.holdChecks, false);
        yield* Ref.set(harness.agents, [agent("ready")]);
        yield* sandboxes.refresh;
        yield* until(sandboxes, discovered("env-2"));
        yield* sandboxes.stop(NAME);
        yield* sandboxes.refresh;
        yield* Ref.set(harness.holdChecks, true);
        yield* sandboxes.start(NAME);
        yield* Deferred.succeed(yield* Queue.take(harness.heldChecks), undefined);
        yield* until(sandboxes, discovered("env-2"));
        yield* Deferred.succeed(stale, undefined);
        yield* sandboxes.refresh;
        assert.strictEqual((yield* sandboxes.snapshot).sandboxes[0]?.environmentId, "env-2");
      }),
    ),
  );

  it.effect("keeps the known Sandboxes when agentctl fails", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* until(sandboxes, discovered("env-1"));
        yield* Ref.set(harness.listFails, true);
        const snapshot = yield* sandboxes.refresh;
        assert.strictEqual(snapshot.status, "available");
        assert.strictEqual(snapshot.error, "agentd is restarting");
        assert.strictEqual(snapshot.sandboxes[0]?.environmentId, "env-1");
      }),
    ),
  );

  it.effect("stops without waiting for the tunnel to close", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* until(sandboxes, discovered("env-1"));
        const result = yield* sandboxes.stop(NAME);
        assert.strictEqual(result.error, null);
        yield* Deferred.await(harness.disconnected);
        const snapshot = yield* sandboxes.refresh;
        assert.strictEqual(snapshot.sandboxes[0]?.phase, "stopped");
        // A stopped Sandbox keeps its environment, like an unreachable SSH host.
        assert.strictEqual(snapshot.sandboxes[0]?.environmentId, "env-1");
      }),
    ),
  );

  it.effect("lets go of a create that agentctl keeps retrying", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* Ref.set(harness.agents, []);
        yield* sandboxes.refresh;
        const result = yield* sandboxes.create({
          manifestPath: "/agents/worker/agent.yaml",
          name: NAME,
        });
        assert.strictEqual(result.error, null);
        const sandbox = (yield* sandboxes.snapshot).sandboxes[0];
        assert.strictEqual(sandbox?.phase, "retrying");
        assert.strictEqual(sandbox?.action, null);
        // Its manifest is offered first for the next Sandbox.
        assert.strictEqual(
          (yield* sandboxes.getSettings).lastManifestPath,
          "/agents/worker/agent.yaml",
        );
      }),
    ),
  );

  it.effect("refuses a name agentctl already has, even one made since the last poll", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* Ref.set(harness.agents, []);
        yield* sandboxes.refresh;
        yield* Ref.set(harness.agents, [agent("ready")]);
        const result = yield* sandboxes.create({
          manifestPath: "/agents/worker/agent.yaml",
          name: NAME,
        });
        assert.strictEqual(result.error, `A Sandbox named ${NAME} already exists.`);
        assert.strictEqual((yield* sandboxes.snapshot).sandboxes[0]?.action ?? null, null);
      }),
    ),
  );

  it.effect("remembers the manifest only when agentctl accepted it", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* Ref.set(harness.agents, []);
        yield* Ref.set(harness.applyFails, true);
        const result = yield* sandboxes.create({
          manifestPath: "/agents/worker/agent.yaml",
          name: NAME,
        });
        assert.strictEqual(result.error, "invalid manifest");
        assert.isUndefined((yield* sandboxes.getSettings).lastManifestPath);
      }),
    ),
  );

  it.effect("checks the environment again when a Sandbox becomes reachable", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* until(sandboxes, discovered("env-1"));
        yield* sandboxes.stop(NAME);
        yield* sandboxes.refresh;
        // Its T3 home was reset while it was stopped.
        harness.environment.id = "env-2";
        yield* sandboxes.start(NAME);
        yield* until(sandboxes, discovered("env-2"));
      }),
    ),
  );

  it.effect("keeps checking a known Sandbox quietly until the check succeeds", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* until(sandboxes, discovered("env-1"));
        yield* sandboxes.stop(NAME);
        yield* sandboxes.refresh;
        harness.environment.id = "env-2";
        yield* Ref.set(harness.ensureFails, true);
        yield* sandboxes.start(NAME);
        // The first check failed: the known environment stays, with no error of its own.
        const failed = yield* sandboxes.refresh;
        assert.strictEqual(failed.sandboxes[0]?.environmentId, "env-1");
        assert.strictEqual(failed.sandboxes[0]?.connectError, null);
        // It is checked again once the throttle passes, and finds the reset environment.
        yield* TestClock.adjust("31 seconds");
        yield* sandboxes.refresh;
        yield* until(sandboxes, discovered("env-2"));
      }),
    ),
  );

  it.effect("does not report a start that a stop cut short as failed", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* until(sandboxes, discovered("env-1"));
        yield* sandboxes.stop(NAME);
        yield* Ref.set(harness.holdStarts, true);
        const starting = yield* Effect.forkChild(sandboxes.start(NAME));
        const gate = yield* Queue.take(harness.heldStarts);
        assert.strictEqual((yield* sandboxes.stop(NAME)).error, null);
        yield* Deferred.succeed(gate, undefined);
        assert.strictEqual((yield* Fiber.join(starting)).error, null);
        const sandbox = (yield* sandboxes.snapshot).sandboxes[0];
        assert.strictEqual(sandbox?.action, null);
        assert.strictEqual(sandbox?.actionError, null);
      }),
    ),
  );

  it.effect("finishes a start whose request went away", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* until(sandboxes, discovered("env-1"));
        yield* sandboxes.stop(NAME);
        yield* Ref.set(harness.holdStarts, true);
        // Like a client that disconnects while agentctl starts the Sandbox.
        const starting = yield* Effect.forkChild(sandboxes.start(NAME));
        const gate = yield* Queue.take(harness.heldStarts);
        yield* Fiber.interrupt(starting);
        yield* Deferred.succeed(gate, undefined);
        yield* until(sandboxes, (snapshot) => snapshot.sandboxes[0]?.action === null);
      }),
    ),
  );

  it.effect("keeps a start shown until the last of two overlapping starts ends", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* until(sandboxes, discovered("env-1"));
        yield* sandboxes.stop(NAME);
        yield* Ref.set(harness.holdStarts, true);
        const firstStart = yield* Effect.forkChild(sandboxes.start(NAME));
        const first = yield* Queue.take(harness.heldStarts);
        // A second window starts it too, before the first request returns.
        const secondStart = yield* Effect.forkChild(sandboxes.start(NAME));
        const second = yield* Queue.take(harness.heldStarts);
        yield* Deferred.succeed(first, undefined);
        assert.strictEqual((yield* Fiber.join(firstStart)).error, null);
        assert.strictEqual((yield* sandboxes.snapshot).sandboxes[0]?.action, "starting");
        yield* Deferred.succeed(second, undefined);
        yield* Fiber.join(secondStart);
        assert.strictEqual((yield* sandboxes.snapshot).sandboxes[0]?.action, null);
      }),
    ),
  );

  it.effect("merges manifest folder changes instead of replacing the list", () =>
    withSandboxes((sandboxes, _harness, stateDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const [a, b, file] = ["a", "b", "file"].map((name) => path.join(stateDir, name));
        yield* fileSystem.makeDirectory(a!, { recursive: true });
        yield* fileSystem.makeDirectory(b!, { recursive: true });
        yield* fileSystem.writeFileString(file!, "not a folder\n");
        yield* sandboxes.addManifestRoot(a!);
        yield* sandboxes.addManifestRoot(`${b}/`);
        // Adding a folder again keeps it once, without an error.
        yield* sandboxes.addManifestRoot(`${a}/`);
        // A file would be opened, and on Windows run, by a desktop client's Open folder.
        const refused = yield* Effect.flip(sandboxes.addManifestRoot(file!));
        assert.strictEqual(refused._tag, "AgentctlManifestRootError");
        assert.strictEqual(
          (yield* Effect.flip(sandboxes.addManifestRoot("relative/agents")))._tag,
          "AgentctlManifestRootError",
        );
        const settings = yield* sandboxes.removeManifestRoot(a!);
        assert.deepStrictEqual(settings.manifestRoots, [b!]);
        assert.deepStrictEqual(yield* sandboxes.listManifestRoots, [
          { directory: b!, exists: true, manifests: 0, repositories: [] },
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("refuses to pull a folder that is not configured", () =>
    withSandboxes((sandboxes) =>
      Effect.gen(function* () {
        const result = yield* sandboxes.pullManifestRoots(["/not-configured"]);
        assert.strictEqual(result.error, "This manifest folder is no longer configured.");
      }),
    ),
  );

  it.effect("remembers a seeded environment until the Sandbox gets a new one", () =>
    withSandboxes((sandboxes, harness) =>
      Effect.gen(function* () {
        yield* until(sandboxes, discovered("env-1"));
        // Another environment's marker is ignored.
        yield* sandboxes.markSettingsSeeded(NAME, EnvironmentId.make("env-other"));
        assert.isFalse((yield* sandboxes.snapshot).sandboxes[0]?.settingsSeeded);
        yield* sandboxes.markSettingsSeeded(NAME, EnvironmentId.make("env-1"));
        assert.isTrue((yield* sandboxes.snapshot).sandboxes[0]?.settingsSeeded);
        // Reaching the same environment again keeps the marker.
        yield* sandboxes.stop(NAME);
        yield* sandboxes.refresh;
        yield* sandboxes.start(NAME);
        yield* sandboxes.refresh;
        assert.isTrue((yield* sandboxes.snapshot).sandboxes[0]?.settingsSeeded);
        // A reset T3 home is a new environment, which is seeded again.
        yield* sandboxes.stop(NAME);
        yield* sandboxes.refresh;
        harness.environment.id = "env-2";
        yield* sandboxes.start(NAME);
        const snapshot = yield* until(sandboxes, discovered("env-2"));
        assert.isFalse(snapshot.sandboxes[0]?.settingsSeeded);
      }),
    ),
  );

  it.effect("sets an unreadable state file aside instead of overwriting it", () =>
    withSandboxes(
      (sandboxes, _harness, stateDir) =>
        Effect.gen(function* () {
          yield* until(sandboxes, discovered("env-1"));
          const fileSystem = yield* FileSystem.FileSystem;
          const entries = yield* fileSystem.readDirectory(stateDir);
          assert.isTrue(
            entries.some((entry) => entry.startsWith("agentctl-sandboxes.json.unreadable-")),
          );
        }).pipe(Effect.provide(NodeServices.layer)),
      (stateDir) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fileSystem.makeDirectory(stateDir, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(stateDir, "agentctl-sandboxes.json"),
            "{oops",
          );
        }),
    ),
  );
});
