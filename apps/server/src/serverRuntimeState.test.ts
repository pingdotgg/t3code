import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { renderBootServicePlist, renderBootServiceUnit } from "./cloud/bootService.ts";
import { runServicePreflight } from "./cloud/servicePreflight.ts";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
} from "./cloud/serviceProtocol.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as ServerOwnership from "./serverOwnership.ts";
import * as ServerRuntimeState from "./serverRuntimeState.ts";

const isServerRuntimeStateError = Schema.is(ServerRuntimeState.ServerRuntimeStateError);

/**
 * Starts a lock-aware server on a T3 home whose user has a boot service unit
 * installed. Process probes are answered from `outputs`, keyed by command
 * name and subcommand; any other probe fails to run.
 */
const startBesideBootService = Effect.fn("test.startBesideBootService")(function* (input: {
  readonly platform: "darwin" | "linux";
  readonly outputs: Readonly<Record<string, { readonly code: number; readonly stdout?: string }>>;
  readonly unitServesOtherHome?: boolean;
  readonly restartPending?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-boot-service-" });
  const t3Home = path.join(root, ".t3");
  const serviceHome = input.unitServesOtherHome ? path.join(root, "other") : t3Home;
  for (const home of [t3Home, serviceHome]) {
    yield* fs.makeDirectory(path.join(home, "userdata"), { recursive: true });
  }
  yield* fs.makeDirectory(path.join(serviceHome, "runtime"));
  yield* fs.writeFileString(
    path.join(serviceHome, "runtime", "service-state.json"),
    `{"protocol":3,"activeVersion":"0.0.42"}\n`,
  );
  if (input.restartPending) {
    yield* fs.writeFileString(path.join(serviceHome, "runtime", ".restart-pending"), "0.0.46\n");
  }
  const plan = { program: [], baseDir: serviceHome, logPath: "", unitPath: "" };
  const [unitPath, unit] =
    input.platform === "darwin"
      ? [
          path.join(root, "Library", "LaunchAgents", "com.t3tools.t3code.service.plist"),
          renderBootServicePlist(plan, { homeDir: root, environmentPath: "" }),
        ]
      : [
          path.join(root, ".config", "systemd", "user", "t3code.service"),
          renderBootServiceUnit(plan),
        ];
  yield* fs.makeDirectory(path.dirname(unitPath), { recursive: true });
  yield* fs.writeFileString(unitPath, unit);

  const invocations: ReadonlyArray<string>[] = [];
  const probeOf = (invocation: ReadonlyArray<string>) =>
    `${path.basename(invocation[0] ?? "")} ${invocation.find((arg, index) => index > 0 && !arg.startsWith("--"))}`;
  const runner = ProcessRunner.ProcessRunner.of({
    run: (run) =>
      Effect.suspend(() => {
        const invocation = [run.command, ...run.args];
        invocations.push(invocation);
        const output = input.outputs[probeOf(invocation)];
        return output === undefined
          ? Effect.fail(
              new ProcessRunner.ProcessSpawnError({
                command: run.command,
                argumentCount: run.args.length,
                cause: new Error("not found"),
              }),
            )
          : Effect.succeed({
              stdout: output.stdout ?? "",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(output.code),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            });
      }),
  });
  const result = yield* Effect.scoped(
    ServerOwnership.acquireServerOwnership(path.join(t3Home, "userdata", "server-runtime.json")),
  ).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(HostProcess.Platform, input.platform),
    Effect.provideService(HostProcess.UserId, 501),
    Effect.provideService(HostProcess.HomeDirectory, root),
    Effect.provideService(HostProcess.Environment, input.environment ?? {}),
    Effect.result,
  );
  return {
    outcome: result._tag === "Success" ? "started" : result.failure._tag,
    invocations,
    probes: invocations.map(probeOf),
    t3Home,
  };
});

const preflightOutput = (answer: object) => ({ code: 0, stdout: `${JSON.stringify(answer)}\n` });
/** What a real 0.0.42 runtime answers: it speaks launcher protocol 2. */
const preLockPreflight = preflightOutput({
  status: "blocked",
  version: "0.0.42",
  reason:
    "This release requires a newer T3 Code service launcher. Update it on the server machine.",
});
const lockAwarePreflight = (launcherProtocol: number) =>
  preflightOutput(runServicePreflight({ databasePath: "/unused", launcherProtocol }));

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

describe("server ownership", () => {
  // An empty home, so no boot service unit installed on this machine is read.
  const layerOwnership = Layer.mergeAll(
    ProcessRunner.layer,
    Layer.effect(
      HostProcess.HomeDirectory,
      Effect.gen(function* () {
        return yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      }),
    ),
    Layer.succeed(HostProcess.Environment, {}),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const makeState = ServerRuntimeState.makePersistedServerRuntimeState({
    config: { host: undefined, devUrl: undefined },
    port: 3773,
  });

  it.effect("lets only one of two racing starts own a state directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-race-" });
      const statePath = path.join(root, "server-runtime.json");
      const attempts = yield* Effect.all(
        [
          ServerOwnership.acquireServerOwnership(statePath).pipe(Effect.result),
          ServerOwnership.acquireServerOwnership(statePath).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(attempts.filter((result) => result._tag === "Success").length, 1);
      const refused = attempts.find((result) => result._tag === "Failure");
      assert.equal(refused?.failure._tag, "ServerAlreadyRunningError");
    }).pipe(Effect.provide(layerOwnership)),
  );

  it.effect("refuses a second owner without touching its record, then allows a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-" });
      const statePath = path.join(root, "server-runtime.json");
      const state = yield* makeState;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* ServerOwnership.acquireServerOwnership(statePath);
          yield* owner.publish(state);
          const before = yield* fs.readFileString(statePath);
          const refused = yield* ServerOwnership.acquireServerOwnership(statePath).pipe(
            Effect.flip,
          );
          assert.equal(refused._tag, "ServerAlreadyRunningError");
          assert.equal(yield* fs.readFileString(statePath), before);
        }),
      );
      assert.isFalse(yield* fs.exists(statePath));
      yield* Effect.scoped(ServerOwnership.acquireServerOwnership(statePath));
    }).pipe(Effect.provide(layerOwnership)),
  );

  it.effect("refuses beside a live pre-lock server and ignores a stale record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-legacy-" });
      const statePath = path.join(root, "server-runtime.json");
      const state = yield* makeState;
      yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        // @effect-diagnostics-next-line globalDateInEffect:off - Legacy identity uses the real process start time, not TestClock.
        state: { ...state, startedAt: new Date().toISOString() },
      });
      const refused = yield* Effect.scoped(ServerOwnership.acquireServerOwnership(statePath)).pipe(
        Effect.flip,
      );
      assert.equal(refused._tag, "ServerAlreadyRunningError");
      yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: { ...state, pid: 0 },
      });
      yield* Effect.scoped(ServerOwnership.acquireServerOwnership(statePath));
    }).pipe(Effect.provide(layerOwnership)),
  );

  it.effect("never removes a runtime record another server published", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-cleanup-" });
      const statePath = path.join(root, "server-runtime.json");
      const state = yield* makeState;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* ServerOwnership.acquireServerOwnership(statePath);
          yield* owner.publish(state);
          yield* ServerRuntimeState.persistServerRuntimeState({
            path: statePath,
            state: { ...state, ownerId: "other-owner" },
          });
        }),
      );
      const remaining = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);
      assert.equal(Option.getOrThrow(remaining).ownerId, "other-owner");
    }).pipe(Effect.provide(layerOwnership)),
  );

  describe("beside an installed boot service", () => {
    it.effect("refuses while a loaded service runs a release without the lock", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        for (const preflight of [
          preLockPreflight,
          preflightOutput({ status: "ready", version: "0.0.45", launcherProtocol: 3 }),
        ]) {
          const started = yield* startBesideBootService({
            platform: "darwin",
            outputs: { "launchctl print": { code: 0 }, "t3 __service-preflight": preflight },
          });
          assert.equal(started.outcome, "OlderBootServiceError", preflight.stdout);
          assert.deepEqual(started.invocations, [
            ["launchctl", "print", "gui/501/com.t3tools.t3code.service"],
            [
              path.join(started.t3Home, "runtime", "versions", "0.0.42", "t3"),
              "__service-preflight",
              "--database-path",
              path.join(started.t3Home, "userdata", "statev2.sqlite"),
              "--launcher-protocol",
              String(SERVICE_LAUNCHER_PROTOCOL),
            ],
          ]);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("refuses a stopped service only when it starts again at login", () =>
      Effect.gen(function* () {
        // macOS 13+ prints enabled/disabled; macOS 12 and earlier print false/true.
        for (const [state, outcome] of [
          ["disabled", "started"],
          ["true", "started"],
          ["enabled", "OlderBootServiceError"],
          ["false", "OlderBootServiceError"],
        ]) {
          const started = yield* startBesideBootService({
            platform: "darwin",
            outputs: {
              "launchctl print": { code: 113 },
              "launchctl print-disabled": {
                code: 0,
                stdout: `disabled services = {\n\t"com.apple.example" => disabled\n\t"com.t3tools.t3code.service" => ${state}\n}\n`,
              },
              "t3 __service-preflight": preLockPreflight,
            },
          });
          assert.equal(started.outcome, outcome, state);
        }
        for (const [active, enabled, outcome] of [
          ["active", "disabled", "OlderBootServiceError"],
          ["inactive", "enabled", "OlderBootServiceError"],
          ["inactive", "disabled", "started"],
          // Waiting out its restart delay.
          ["activating", "disabled", "OlderBootServiceError"],
        ]) {
          const started = yield* startBesideBootService({
            platform: "linux",
            outputs: {
              "systemctl is-active": { code: active === "active" ? 0 : 3, stdout: `${active}\n` },
              "systemctl is-enabled": {
                code: enabled === "enabled" ? 0 : 1,
                stdout: `${enabled}\n`,
              },
              "t3 __service-preflight": preLockPreflight,
            },
          });
          assert.equal(started.outcome, outcome, `${active} ${enabled}`);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("starts beside a service whose runtime takes the lock", () =>
      Effect.gen(function* () {
        // A later runtime answers this launcher protocol with "blocked".
        for (const launcherProtocol of [SERVICE_LAUNCHER_PROTOCOL, SERVICE_LAUNCHER_PROTOCOL + 1]) {
          const started = yield* startBesideBootService({
            platform: "darwin",
            outputs: {
              "launchctl print": { code: 0 },
              "t3 __service-preflight": lockAwarePreflight(launcherProtocol),
            },
          });
          assert.equal(started.outcome, "started", String(launcherProtocol));
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("refuses a loaded service that has not restarted into its update", () =>
      Effect.gen(function* () {
        const started = yield* startBesideBootService({
          platform: "darwin",
          restartPending: true,
          outputs: {
            "launchctl print": { code: 0 },
            "t3 __service-preflight": lockAwarePreflight(SERVICE_LAUNCHER_PROTOCOL),
          },
        });
        assert.equal(started.outcome, "OlderBootServiceError");
        assert.deepEqual(started.probes, ["launchctl print"]);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("never probes another home's service or from the service's own server", () =>
      Effect.gen(function* () {
        const outputs = {
          "launchctl print": { code: 0 },
          "t3 __service-preflight": preLockPreflight,
        };
        for (const started of [
          yield* startBesideBootService({ platform: "darwin", outputs, unitServesOtherHome: true }),
          yield* startBesideBootService({
            platform: "darwin",
            outputs,
            environment: { [SERVICE_LAUNCHER_CONTEXT_ENV]: "{}" },
          }),
        ]) {
          assert.equal(started.outcome, "started");
          assert.deepEqual(started.probes, []);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("starts when the service runtime cannot be probed", () =>
      Effect.gen(function* () {
        for (const outputs of [
          { "launchctl print": { code: 0 } },
          {
            "launchctl print": { code: 0 },
            "t3 __service-preflight": { ...preLockPreflight, code: 1 },
          },
        ]) {
          const started = yield* startBesideBootService({ platform: "darwin", outputs });
          assert.equal(started.outcome, "started");
          assert.deepEqual(started.probes, ["launchctl print", "t3 __service-preflight"]);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });
});

describe("serverRuntimeState", () => {
  it.effect("persists and reads the runtime state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "runtime", "server.json");
      const state: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 123,
        host: "127.0.0.1",
        port: 4_971,
        origin: "http://127.0.0.1:4971",
        devUrl: "http://localhost:5733/",
        startedAt: "2026-06-20T00:00:00.000Z",
      };

      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state });
      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.deepEqual(Option.getOrThrow(restored), state);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("records the dev web URL when the server fronts a dev server", () =>
    Effect.gen(function* () {
      const state = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: new URL("http://localhost:5733") },
        port: 13_773,
      });

      assert.equal(state.devUrl, "http://localhost:5733/");
      assert.equal(state.origin, "http://127.0.0.1:13773");

      const withoutDev = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 13_773,
      });
      assert.isFalse("devUrl" in withoutDev);
    }),
  );

  it.effect("marks a service-supervised server so CLIs can tell it from a manual one", () =>
    Effect.gen(function* () {
      const managed = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 13_773,
        serviceManaged: true,
      });
      const manual = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 13_773,
      });

      assert.isTrue(managed.serviceManaged);
      assert.isFalse("serviceManaged" in manual);
    }),
  );

  it.effect("treats a missing runtime state file as absent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(
        path.join(root, "missing.json"),
      );

      assert.isTrue(Option.isNone(restored));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves malformed state decode failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.writeFileString(statePath, "{not json");

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to decode server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "decode");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to decode server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "SchemaError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("preserves runtime state read failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.makeDirectory(statePath);

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to read server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "read");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to read server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });

  it.effect("preserves runtime state persistence failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const blockedDirectory = path.join(root, "not-a-directory");
      const statePath = path.join(blockedDirectory, "server.json");
      yield* fileSystem.writeFileString(blockedDirectory, "blocked");

      const error = yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: {
          version: 1,
          pid: 123,
          port: 4_971,
          origin: "http://127.0.0.1:4971",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }).pipe(Effect.flip);

      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "persist");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to persist server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
