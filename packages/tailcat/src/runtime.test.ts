import { assert, describe, expect, it } from "@effect/vitest";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { tailcatFailureCode } from "./errors.ts";
import { TAILCAT_COMPATIBLE_RANGE, TAILCAT_PINNED_VERSION } from "./manifest.ts";
import {
  TAILCAT_PROCESS_STOP_GRACE,
  TAILCAT_SERVE_READY_TIMEOUT,
  type TailcatAllowPolicy,
  type TailcatExecutableResolution,
  TailcatRuntime,
  layer as tailcatRuntimeLayer,
} from "./runtime.ts";

// Captured from a real `tailcat serve` run; the runtime decodes it before trusting it.
const ADDRESS =
  "tco2FwWCB-p3FjjOrzlCPp0w8aT3p9xDZ1nNaXWX_dASxDCFT_MmFrWCDRnh2-iykbZ7W4Fl0g3nBpwTnR3iXVCKKCk4pps47ndGFpGQEu";
const NODE_KEY = "nodekey:9ab555a4a588b75d2054adb683db82461bb6c707d43e8ba39439f8eb1e821503";
const LISTEN_LINE = `{"listenAddr":"${ADDRESS}"}\n`;

const OVERRIDE = "/home/dev/bin/tailcat";
const BUNDLED = "/opt/t3/resources/tailcat/linux-x64/tailcat";
const MISSING_BUNDLED = "/opt/t3/resources/tailcat/tailcat";
const SYSTEM = "/usr/bin/tailcat";
const SERVER_KEY = "/state/tailcat/server.key";
const CLIENT_KEY = "/state/tailcat/client.key";
const KILLED_EXIT_CODE = 143;
// The TestClock starts at the epoch, so `measuredAt` is fixed.
const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

const encoder = new TextEncoder();
const text = (content: string): Stream.Stream<Uint8Array> => Stream.make(encoder.encode(content));

/** One scripted tailcat process. Without `exitCode` it runs until killed. */
interface FakeProcess {
  readonly stdout?: Stream.Stream<Uint8Array>;
  readonly stderr?: Stream.Stream<Uint8Array>;
  readonly exitCode?: number;
  /** Runs once the process has been spawned, for tests that sequence on it. */
  readonly onSpawn?: Effect.Effect<void>;
}

interface SpawnRecord {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.StandardCommand["options"];
  readonly kills: ReadonlyArray<ChildProcess.KillOptions | undefined>;
}

interface FakeTailcat {
  readonly spawns: ReadonlyArray<SpawnRecord>;
  readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
}

const subcommandOf = (args: ReadonlyArray<string>) =>
  args.find((arg) => !arg.startsWith("--")) ?? "";

const spawnFor = (tailcat: FakeTailcat, subcommand: string) =>
  tailcat.spawns.find((spawn) => subcommandOf(spawn.args) === subcommand);

const versionProcess = (version = `v${TAILCAT_PINNED_VERSION}`): FakeProcess => ({
  stdout: text(`${version}\n`),
  exitCode: 0,
});

/**
 * A ChildProcessSpawner that plays scripted processes keyed by tailcat
 * subcommand. Like the Node spawner, a process still running when its scope
 * closes is killed, and killing settles its exit code.
 */
function fakeTailcat(processes: Readonly<Record<string, FakeProcess>>): FakeTailcat {
  const spawns: Array<SpawnRecord> = [];
  const spawner = ChildProcessSpawner.make(
    Effect.fnUntraced(function* (command) {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* Effect.die(new Error("tailcat is never spawned through a pipeline"));
      }
      const fake = processes[subcommandOf(command.args)];
      if (fake === undefined) {
        return yield* Effect.die(new Error(`unexpected tailcat ${command.args.join(" ")}`));
      }
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      if (fake.exitCode !== undefined) {
        yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(fake.exitCode));
      }
      const kills: Array<ChildProcess.KillOptions | undefined> = [];
      const kill = (options?: ChildProcess.KillOptions) =>
        Effect.suspend(() => {
          kills.push(options);
          return Deferred.succeed(exit, ChildProcessSpawner.ExitCode(KILLED_EXIT_CODE)).pipe(
            Effect.asVoid,
          );
        });
      // A process that already exited has closed its pipes; a live one keeps them open.
      const idle = fake.exitCode === undefined ? Stream.never : Stream.empty;
      const stdout = fake.stdout ?? idle;
      const stderr = fake.stderr ?? idle;
      spawns.push({
        command: command.command,
        args: command.args,
        options: command.options,
        kills,
      });
      yield* Effect.addFinalizer(() =>
        Effect.flatMap(Deferred.isDone(exit), (done) => (done ? Effect.void : kill())),
      );
      if (fake.onSpawn !== undefined) {
        yield* fake.onSpawn;
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(4242),
        stdin: Sink.drain,
        stdout,
        stderr,
        all: Stream.merge(stdout, stderr),
        exitCode: Deferred.await(exit),
        isRunning: Effect.map(Deferred.isDone(exit), (done) => !done),
        kill,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  return { spawns, layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner) };
}

interface FakeHost {
  readonly resolution?: TailcatExecutableResolution;
  /** Paths that exist on disk; everything else is missing. Defaults to the bundled binary. */
  readonly existing?: ReadonlyArray<string>;
  /** File modes reported by stat, for paths that should not look executable. */
  readonly modes?: Readonly<Record<string, number>>;
  readonly environment?: NodeJS.ProcessEnv;
  /** Whether something accepts connections on the forwarded loopback port. */
  readonly listening?: boolean;
}

const bundledOnly: TailcatExecutableResolution = {
  bundledCandidates: [BUNDLED],
  allowSystem: false,
};

const fileInfo = (mode: number): FileSystem.File.Info => ({
  type: "File",
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(0),
  blksize: Option.none(),
  blocks: Option.none(),
});

const notFound = (method: string, path: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
  });

function runtimeLayer(tailcat: FakeTailcat, host: FakeHost = {}) {
  const existing = new Set(host.existing ?? [BUNDLED]);
  const modes = host.modes ?? {};
  const fileSystem = FileSystem.layerNoop({
    exists: (path) => Effect.succeed(existing.has(path)),
    stat: (path) => {
      const mode = modes[path];
      return mode === undefined
        ? Effect.fail(notFound("stat", path))
        : Effect.succeed(fileInfo(mode));
    },
  });
  const net = Layer.succeed(NetService.NetService, {
    canListenOnHost: () => Effect.succeed(true),
    isPortAvailableOnLoopback: () => Effect.succeed(true),
    hasListenerOnHost: () => Effect.succeed(host.listening ?? true),
    reserveLoopbackPort: () => Effect.succeed(0),
    findAvailablePort: (preferred) => Effect.succeed(preferred),
  });
  return tailcatRuntimeLayer({ resolution: host.resolution ?? bundledOnly }).pipe(
    Layer.provide(
      Layer.mergeAll(
        tailcat.layer,
        fileSystem,
        Path.layer,
        net,
        Layer.succeed(HostProcessPlatform, "linux"),
        Layer.succeed(HostProcessArchitecture, "x64"),
        Layer.succeed(HostProcessEnvironment, host.environment ?? {}),
      ),
    ),
  );
}

describe("TailcatRuntime.resolve", () => {
  it.effect("prefers the developer override and caches the result", () => {
    const tailcat = fakeTailcat({ version: versionProcess() });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;

      const info = yield* runtime.resolve;
      expect(info).toEqual({
        executablePath: OVERRIDE,
        source: "override",
        version: TAILCAT_PINNED_VERSION,
        pinnedVersion: TAILCAT_PINNED_VERSION,
        compatible: true,
      });
      expect(tailcat.spawns.map((spawn) => [spawn.command, ...spawn.args])).toEqual([
        [OVERRIDE, "version"],
      ]);

      yield* runtime.resolve;
      expect(tailcat.spawns).toHaveLength(1);
      yield* runtime.refresh;
      expect(tailcat.spawns).toHaveLength(2);
    }).pipe(
      Effect.provide(
        runtimeLayer(tailcat, {
          resolution: { overridePath: OVERRIDE, bundledCandidates: [BUNDLED], allowSystem: true },
          existing: [OVERRIDE, BUNDLED, SYSTEM],
          environment: { PATH: "/usr/local/bin:/usr/bin" },
        }),
      ),
    );
  });

  it.effect("falls back to the first bundled candidate that exists", () => {
    const tailcat = fakeTailcat({ version: versionProcess() });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const info = yield* runtime.resolve;
      expect(info.source).toBe("bundled");
      expect(info.executablePath).toBe(BUNDLED);
      expect(tailcat.spawns.map((spawn) => spawn.command)).toEqual([BUNDLED]);
    }).pipe(
      Effect.provide(
        runtimeLayer(tailcat, {
          resolution: { bundledCandidates: [MISSING_BUNDLED, BUNDLED], allowSystem: false },
          existing: [BUNDLED],
        }),
      ),
    );
  });

  it.effect("accepts a tailcat on PATH when system binaries are allowed", () => {
    const tailcat = fakeTailcat({ version: versionProcess() });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const info = yield* runtime.resolve;
      expect(info.source).toBe("system");
      expect(info.executablePath).toBe(SYSTEM);
      expect(info.compatible).toBe(true);
    }).pipe(
      Effect.provide(
        runtimeLayer(tailcat, {
          resolution: { bundledCandidates: [MISSING_BUNDLED], allowSystem: true },
          existing: [SYSTEM],
          environment: { PATH: "/usr/local/bin:/usr/bin" },
        }),
      ),
    );
  });

  it.effect("fails with binary-missing when nothing is found and PATH is off limits", () => {
    const tailcat = fakeTailcat({ version: versionProcess() });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const error = yield* runtime.resolve.pipe(Effect.flip);
      assert(error._tag === "TailcatBinaryMissingError");
      expect(error.candidates).toEqual([MISSING_BUNDLED]);
      expect(tailcatFailureCode(error)).toBe("binary-missing");
      expect(tailcat.spawns).toHaveLength(0);
    }).pipe(
      Effect.provide(
        runtimeLayer(tailcat, {
          resolution: { bundledCandidates: [MISSING_BUNDLED], allowSystem: false },
          existing: [SYSTEM],
          environment: { PATH: "/usr/local/bin:/usr/bin" },
        }),
      ),
    );
  });

  it.effect("rejects a missing override without trying other candidates", () => {
    const tailcat = fakeTailcat({ version: versionProcess() });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const error = yield* runtime.resolve.pipe(Effect.flip);
      assert(error._tag === "TailcatBinaryMissingError");
      expect(error.candidates).toEqual([OVERRIDE]);
      expect(error.detail).toContain("T3CODE_TAILCAT_BINARY");
      expect(tailcat.spawns).toHaveLength(0);
    }).pipe(
      Effect.provide(
        runtimeLayer(tailcat, {
          resolution: { overridePath: OVERRIDE, bundledCandidates: [BUNDLED], allowSystem: false },
          existing: [BUNDLED],
        }),
      ),
    );
  });

  it.effect("rejects a binary that is not executable", () => {
    const tailcat = fakeTailcat({ version: versionProcess() });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const error = yield* runtime.resolve.pipe(Effect.flip);
      assert(error._tag === "TailcatBinaryNotExecutableError");
      expect(error.path).toBe(BUNDLED);
      expect(tailcatFailureCode(error)).toBe("binary-not-executable");
      expect(tailcat.spawns).toHaveLength(0);
    }).pipe(Effect.provide(runtimeLayer(tailcat, { modes: { [BUNDLED]: 0o644 } })));
  });

  it.effect("rejects a version outside the compatible range", () => {
    const tailcat = fakeTailcat({ version: versionProcess("v9.0.0") });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const error = yield* runtime.resolve.pipe(Effect.flip);
      assert(error._tag === "TailcatVersionIncompatibleError");
      expect(error.path).toBe(BUNDLED);
      expect(error.version).toBe("9.0.0");
      expect(error.compatibleRange).toBe(TAILCAT_COMPATIBLE_RANGE);
      expect(tailcatFailureCode(error)).toBe("version-incompatible");
    }).pipe(Effect.provide(runtimeLayer(tailcat)));
  });

  it.effect("fails when tailcat version prints nothing usable", () => {
    const tailcat = fakeTailcat({
      version: { stdout: text("tailcat: unknown command\n"), exitCode: 0 },
    });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const error = yield* runtime.resolve.pipe(Effect.flip);
      assert(error._tag === "TailcatCommandError");
      expect(error.subcommand).toBe("version");
      expect(error.exitCode).toBe(0);
    }).pipe(Effect.provide(runtimeLayer(tailcat)));
  });
});

describe("TailcatRuntime.serve", () => {
  const allow: TailcatAllowPolicy = { _tag: "keys", nodeKeys: [NODE_KEY] };
  const serveInput = { keyPath: SERVER_KEY, localPort: 3773, allow };

  it.effect("publishes the address from the JSON listen line", () => {
    const tailcat = fakeTailcat({
      version: versionProcess(),
      serve: { stdout: text(LISTEN_LINE) },
    });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const handle = yield* runtime.serve(serveInput);
      expect(handle.address).toBe(ADDRESS);
      expect(handle.localPort).toBe(3773);
      expect(handle.allow).toEqual(allow);
      expect(handle.pid).toBe(4242);
      expect(yield* handle.isRunning).toBe(true);

      const serve = spawnFor(tailcat, "serve");
      assert(serve !== undefined);
      expect(serve.command).toBe(BUNDLED);
      expect(serve.args).toEqual([
        "--json",
        `--key=${SERVER_KEY}`,
        "serve",
        `--allow=${NODE_KEY}`,
        "3773",
      ]);
      expect(serve.options.stdin).toBe("ignore");
      expect(serve.options.killSignal).toBe("SIGTERM");
    }).pipe(Effect.provide(runtimeLayer(tailcat)));
  });

  it.effect("stop terminates the process and settles exit", () => {
    const tailcat = fakeTailcat({
      version: versionProcess(),
      serve: { stdout: text(LISTEN_LINE) },
    });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const handle = yield* runtime.serve(serveInput);

      yield* handle.stop;

      const serve = spawnFor(tailcat, "serve");
      assert(serve !== undefined);
      expect(serve.kills).toEqual([
        { killSignal: "SIGTERM", forceKillAfter: TAILCAT_PROCESS_STOP_GRACE },
      ]);
      expect(yield* handle.exit).toEqual(Option.some(KILLED_EXIT_CODE));
      expect(yield* handle.isRunning).toBe(false);
    }).pipe(Effect.provide(runtimeLayer(tailcat)));
  });

  it.effect("closing the owning scope kills the process", () => {
    const tailcat = fakeTailcat({
      version: versionProcess(),
      serve: { stdout: text(LISTEN_LINE) },
    });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const scope = yield* Scope.make();
      const handle = yield* runtime.serve(serveInput).pipe(Scope.provide(scope));
      expect(yield* handle.isRunning).toBe(true);

      yield* Scope.close(scope, Exit.void);

      expect(spawnFor(tailcat, "serve")?.kills).toHaveLength(1);
      expect(yield* handle.isRunning).toBe(false);
    }).pipe(Effect.provide(runtimeLayer(tailcat)));
  });

  it.effect("fails with a startup error when the process exits before publishing", () => {
    const tailcat = fakeTailcat({
      version: versionProcess(),
      // stdout stays open so the exit, not an early EOF, decides the race.
      serve: {
        stdout: Stream.never,
        stderr: text("tailcat: could not bootstrap: no route to DERP\n"),
        exitCode: 1,
      },
    });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const error = yield* runtime.serve(serveInput).pipe(Effect.flip);
      assert(error._tag === "TailcatStartupError");
      expect(error.subcommand).toBe("serve");
      expect(error.exitCode).toBe(1);
      expect(error.recentOutput).toEqual(["tailcat: could not bootstrap: no route to DERP"]);
      expect(error.detail).toBe(
        "Tailcat could not start serving: tailcat: could not bootstrap: no route to DERP",
      );
      expect(tailcatFailureCode(error)).toBe("startup-failed");
    }).pipe(Effect.provide(runtimeLayer(tailcat)));
  });

  it.effect("reports a port conflict from the process output", () => {
    const tailcat = fakeTailcat({
      version: versionProcess(),
      serve: {
        stdout: Stream.never,
        stderr: text("listen tcp 127.0.0.1:3773: bind: address already in use\n"),
        exitCode: 1,
      },
    });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const error = yield* runtime.serve(serveInput).pipe(Effect.flip);
      assert(error._tag === "TailcatPortInUseError");
      expect(error.port).toBe(3773);
      expect(tailcatFailureCode(error)).toBe("port-in-use");
    }).pipe(Effect.provide(runtimeLayer(tailcat)));
  });

  it.effect("times out and kills a process that never publishes an address", () =>
    Effect.gen(function* () {
      const spawned = yield* Deferred.make<void>();
      const tailcat = fakeTailcat({
        version: versionProcess(),
        serve: { onSpawn: Deferred.succeed(spawned, undefined).pipe(Effect.asVoid) },
      });
      const error = yield* Effect.gen(function* () {
        const runtime = yield* TailcatRuntime;
        const fiber = yield* runtime.serve(serveInput).pipe(Effect.forkScoped);
        yield* Deferred.await(spawned);
        yield* TestClock.adjust(TAILCAT_SERVE_READY_TIMEOUT);
        return yield* Fiber.join(fiber).pipe(Effect.flip);
      }).pipe(Effect.provide(runtimeLayer(tailcat)));

      assert(error._tag === "TailcatTimeoutError", `${error._tag}: ${error.detail}`);
      expect(error.subcommand).toBe("serve");
      expect(error.timeoutMs).toBe(30_000);
      expect(tailcatFailureCode(error)).toBe("timeout");
      expect(spawnFor(tailcat, "serve")?.kills).toHaveLength(1);
    }),
  );
});

describe("TailcatRuntime.forward", () => {
  const forwardInput = {
    keyPath: CLIENT_KEY,
    address: ADDRESS,
    remotePort: 3773,
    localPort: 40123,
  };

  it.effect("forwards a reserved loopback port once the tunnel is ready", () => {
    const tailcat = fakeTailcat({ version: versionProcess(), forward: {} });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const probed: Array<string> = [];
      const handle = yield* runtime.forward({
        ...forwardInput,
        readiness: (endpoint) =>
          Effect.sync(() => {
            probed.push(endpoint.httpBaseUrl);
          }),
      });
      expect(handle.address).toBe(ADDRESS);
      expect(handle.remotePort).toBe(3773);
      expect(handle.localPort).toBe(40123);
      expect(handle.httpBaseUrl).toBe("http://127.0.0.1:40123/");
      expect(handle.wsBaseUrl).toBe("ws://127.0.0.1:40123/");
      expect(probed).toEqual(["http://127.0.0.1:40123/"]);
      expect(yield* handle.isRunning).toBe(true);

      yield* runtime.forward({ ...forwardInput, keyPath: null, localPort: 40124 });

      const forwards = tailcat.spawns.filter((spawn) => subcommandOf(spawn.args) === "forward");
      expect(forwards.map((spawn) => spawn.command)).toEqual([BUNDLED, BUNDLED]);
      expect(forwards.map((spawn) => spawn.args)).toEqual([
        [`--key=${CLIENT_KEY}`, "forward", ADDRESS, "40123:3773"],
        ["forward", ADDRESS, "40124:3773"],
      ]);
    }).pipe(Effect.provide(runtimeLayer(tailcat)));
  });

  it.effect("fails with a startup error when the forwarder exits early", () => {
    const tailcat = fakeTailcat({
      version: versionProcess(),
      forward: { stderr: text("forward: the remote machine rejected this client\n"), exitCode: 2 },
    });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const error = yield* runtime.forward(forwardInput).pipe(Effect.flip);
      assert(error._tag === "TailcatStartupError");
      expect(error.subcommand).toBe("forward");
      expect(error.exitCode).toBe(2);
      expect(error.detail).toBe(
        "Tailcat could not start forwarding: forward: the remote machine rejected this client",
      );
    }).pipe(Effect.provide(runtimeLayer(tailcat, { listening: false })));
  });

  it.effect("kills the forwarder when the readiness probe fails", () => {
    const tailcat = fakeTailcat({ version: versionProcess(), forward: {} });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const error = yield* runtime
        .forward({
          ...forwardInput,
          readiness: () => Effect.fail({ _tag: "ProbeFailed" as const }),
        })
        .pipe(Effect.flip);
      expect(error).toEqual({ _tag: "ProbeFailed" });
      expect(spawnFor(tailcat, "forward")?.kills).toEqual([
        { killSignal: "SIGTERM", forceKillAfter: TAILCAT_PROCESS_STOP_GRACE },
      ]);
    }).pipe(Effect.provide(runtimeLayer(tailcat)));
  });

  it.effect("rejects an address that is not a tailcat code before spawning", () => {
    const tailcat = fakeTailcat({ version: versionProcess() });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const error = yield* runtime
        .forward({ ...forwardInput, address: "https://example.com" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("TailcatAddressInvalidError");
      expect(spawnFor(tailcat, "forward")).toBeUndefined();
    }).pipe(Effect.provide(runtimeLayer(tailcat)));
  });

  it.effect("times out and kills a forwarder the remote never answers through", () =>
    Effect.gen(function* () {
      const spawned = yield* Deferred.make<void>();
      const tailcat = fakeTailcat({
        version: versionProcess(),
        forward: { onSpawn: Deferred.succeed(spawned, undefined).pipe(Effect.asVoid) },
      });
      const error = yield* Effect.gen(function* () {
        const runtime = yield* TailcatRuntime;
        const fiber = yield* runtime
          .forward({
            ...forwardInput,
            readiness: () => Effect.never,
            readinessTimeout: "5 seconds",
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(spawned);
        yield* TestClock.adjust("5 seconds");
        return yield* Fiber.join(fiber).pipe(Effect.flip);
      }).pipe(Effect.provide(runtimeLayer(tailcat)));

      assert(error._tag === "TailcatTimeoutError", `${error._tag}: ${error.detail}`);
      expect(error.subcommand).toBe("forward");
      expect(error.timeoutMs).toBe(5_000);
      expect(tailcatFailureCode(error)).toBe("timeout");
      expect(spawnFor(tailcat, "forward")?.kills).toHaveLength(1);
    }),
  );
});

describe("TailcatRuntime.ping", () => {
  it.effect("reports a direct path", () => {
    const tailcat = fakeTailcat({
      version: versionProcess(),
      ping: { stdout: text("pong in 280µs via 192.168.50.12:49590\n"), exitCode: 0 },
    });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const probe = yield* runtime.ping({ keyPath: CLIENT_KEY, address: ADDRESS });
      expect(probe).toEqual({
        kind: "direct",
        via: "192.168.50.12:49590",
        latencyMs: 0.28,
        measuredAt: EPOCH_ISO,
      });
      expect(spawnFor(tailcat, "ping")?.args).toEqual([
        `--key=${CLIENT_KEY}`,
        "ping",
        "--timeout=8s",
        ADDRESS,
      ]);
    }).pipe(Effect.provide(runtimeLayer(tailcat)));
  });

  it.effect("reports a relayed path", () => {
    const tailcat = fakeTailcat({
      version: versionProcess(),
      ping: { stdout: text("pong in 12.5ms via DERP(sfo)\n"), exitCode: 0 },
    });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const probe = yield* runtime.ping({ keyPath: null, address: ADDRESS, timeout: "2 seconds" });
      expect(probe).toEqual({ kind: "relay", via: "sfo", latencyMs: 12.5, measuredAt: EPOCH_ISO });
      expect(spawnFor(tailcat, "ping")?.args).toEqual(["ping", "--timeout=2s", ADDRESS]);
    }).pipe(Effect.provide(runtimeLayer(tailcat)));
  });

  it.effect("fails when the remote does not answer", () => {
    const tailcat = fakeTailcat({
      version: versionProcess(),
      ping: { stderr: text("ping: no response\n"), exitCode: 1 },
    });
    return Effect.gen(function* () {
      const runtime = yield* TailcatRuntime;
      const error = yield* runtime.ping({ keyPath: null, address: ADDRESS }).pipe(Effect.flip);
      assert(error._tag === "TailcatCommandError");
      expect(error.subcommand).toBe("ping");
      expect(error.exitCode).toBe(1);
    }).pipe(Effect.provide(runtimeLayer(tailcat)));
  });
});
