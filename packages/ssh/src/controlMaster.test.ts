// @effect-diagnostics nodeBuiltinImport:off - the fake ssh child acts synchronously inside the spawner.
import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@lathe/shared/HostProcess";
import * as NetService from "@lathe/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner, CommandLine } from "effect/process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as SshAuth from "./auth.ts";
import { controlSocketPath } from "./controlMaster.ts";
import * as SshTunnel from "./tunnel.ts";

const encoder = new TextEncoder();
const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;
const target = { alias: "devbox", hostname: "devbox", username: null, port: null };

describe("control socket path", () => {
  const stateKey = "711bc738002d72fd";

  it("names the socket after the target's state key", () => {
    assert.equal(
      controlSocketPath({ directory: "/Users/julius/.lathe/ssh/", stateKey, platform: "darwin" }),
      "/Users/julius/.lathe/ssh/711bc738002d72fd.sock",
    );
  });

  // OpenSSH binds `<path>.<16 random chars>` and links it into place, so that
  // name and its NUL must fit the platform's sun_path: 104 bytes on darwin and
  // 108 on linux.
  it("refuses a path whose temporary bind name would not fit the platform's sun_path", () => {
    const socketName = `/${stateKey}.sock`;
    const directoryOf = (bytes: number) => `/${"d".repeat(bytes - socketName.length - 1)}`;

    assert.isNotNull(
      controlSocketPath({ directory: directoryOf(86), stateKey, platform: "darwin" }),
    );
    assert.isNull(controlSocketPath({ directory: directoryOf(87), stateKey, platform: "darwin" }));
    assert.isNotNull(
      controlSocketPath({ directory: directoryOf(90), stateKey, platform: "linux" }),
    );
    assert.isNull(controlSocketPath({ directory: directoryOf(91), stateKey, platform: "linux" }));
    // Bytes, not characters.
    assert.isNull(
      controlSocketPath({
        directory: `/${"é".repeat(40)}`,
        stateKey,
        platform: "darwin",
      }),
    );
  });

  it("never multiplexes on Windows", () => {
    assert.isNull(controlSocketPath({ directory: "C:\\lathe\\ssh", stateKey, platform: "win32" }));
  });
});

type MasterBehavior =
  | { readonly _tag: "ready" }
  | { readonly _tag: "exits"; readonly stderr: string }
  /** Keeps running as a plain connection, saying why it opened no socket. */
  | { readonly _tag: "refuses"; readonly stderr: string }
  | { readonly _tag: "silent" };

/**
 * Holds the code under test at one point until the test opens it. `reached`
 * resolves once the code has arrived there.
 */
const makeGate = () => {
  let arrive = () => {};
  let release = () => {};
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    pass: Effect.sync(() => arrive()).pipe(Effect.andThen(Effect.promise(() => opened))),
    reached: Effect.promise(() => arrived),
    open: Effect.sync(() => release()),
  };
};
type Gate = ReturnType<typeof makeGate>;

/**
 * Routes each ssh invocation by shape and records it. A ready master reads
 * its askpass secret and creates its socket when the app first looks for the
 * socket, like a real master that authenticates after it was spawned.
 */
const makeHarness = (input: {
  readonly master?: (attempt: number) => MasterBehavior;
  readonly probe?: (attempt: number) => "ok" | "hang";
  readonly launch?: (attempt: number) => { readonly exitCode: number; readonly stderr?: string };
  readonly prompt?: () => string | null;
  /** Held right after the askpass secret file is written. */
  readonly secretWritten?: Gate;
  /** Held when the app kills a master that already exited on its own. */
  readonly exitedMasterKill?: Gate;
}) => {
  const events: Array<string> = [];
  const spawned: Array<{
    readonly kind: string;
    readonly args: ReadonlyArray<string>;
    readonly env: Record<string, CommandLine.Word | undefined>;
  }> = [];
  const secretFilesSeen: Array<{ readonly path: string; readonly contents: string }> = [];
  const secretFilesWritten: Array<string> = [];
  // Sockets of ready masters that have not authenticated yet.
  const pendingSockets = new Map<string, () => void>();
  // Ends the latest master as a crash would, leaving its socket behind.
  let crashLatestMaster: Effect.Effect<void> = Effect.void;
  let masters = 0;
  let probes = 0;
  let launches = 0;
  let prompts = 0;
  const spawnWaiters = new Map<string, () => void>();

  const exitedProcess = (stdout: string, exitCode = 0, stderr = "") =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(200),
      stdout: Stream.make(encoder.encode(stdout)),
      stderr: stderr.length === 0 ? Stream.empty : Stream.make(encoder.encode(stderr)),
      all: Stream.empty,
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });

  const runningProcess = (name: string, stderr: string, onKill: () => void = () => {}) =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      if (name === "master") {
        crashLatestMaster = Deferred.succeed(exited, ChildProcessSpawner.ExitCode(255)).pipe(
          Effect.asVoid,
        );
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(300),
        stdout: Stream.empty,
        stderr: stderr.length === 0 ? Stream.empty : Stream.make(encoder.encode(stderr)),
        all: Stream.empty,
        exitCode: Deferred.await(exited),
        isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
        kill: () =>
          Effect.gen(function* () {
            if (yield* Deferred.isDone(exited)) {
              if (name === "master" && input.exitedMasterKill !== undefined) {
                yield* input.exitedMasterKill.pass;
              }
              return;
            }
            events.push(`${name}.kill`);
            onKill();
            yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(143));
          }),
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    });

  const kindOf = (args: ReadonlyArray<string>) => {
    if (args.includes("ControlMaster=yes")) return "master";
    if (args.includes("-G")) return "resolve";
    if (args.includes("-O")) return `control.${args[args.indexOf("-O") + 1]}`;
    if (args.includes("-N")) return "tunnel";
    if (args.at(-1) === "true") return "probe";
    // Only the launch passes arguments to the remote sh.
    if (/ sh (?:-l )?-s -- /u.test(args.join(" "))) return "launch";
    return "script";
  };

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args.map(String) : [];
      const env = command._tag === "StandardCommand" ? (command.options.env ?? {}) : {};
      const kind = kindOf(args);
      spawned.push({ kind, args, env });
      if (kind !== "resolve") events.push(kind);
      spawnWaiters.get(kind)?.();
      switch (kind) {
        case "resolve":
          return exitedProcess("");
        case "master": {
          const socket = controlPathOf(args);
          const behavior = input.master?.(++masters) ?? { _tag: "ready" };
          if (behavior._tag === "exits") {
            return exitedProcess("", 255, behavior.stderr);
          }
          if (behavior._tag === "ready" && socket !== undefined) {
            pendingSockets.set(socket, () => {
              const secretFile = env.LATHE_SSH_AUTH_SECRET_FILE;
              if (typeof secretFile === "string" && NodeFS.existsSync(secretFile)) {
                secretFilesSeen.push({
                  path: secretFile,
                  contents: NodeFS.readFileSync(secretFile, "utf8"),
                });
              }
              NodeFS.writeFileSync(socket, "");
            });
          }
          // A real master removes its socket when it is told to stop.
          return yield* runningProcess(
            "master",
            behavior._tag === "refuses" ? behavior.stderr : "",
            () => {
              if (socket !== undefined) NodeFS.rmSync(socket, { force: true });
            },
          );
        }
        case "probe":
          return (input.probe?.(++probes) ?? "ok") === "ok"
            ? exitedProcess("")
            : yield* runningProcess("probe", "");
        case "tunnel":
          return yield* runningProcess("tunnel", "");
        case "launch": {
          const result = input.launch?.(++launches) ?? { exitCode: 0 };
          return exitedProcess(
            result.exitCode === 0 ? '{"remotePort":3773,"serverKind":"managed"}\n' : "",
            result.exitCode,
            result.stderr ?? "",
          );
        }
        case "control.exit":
          return exitedProcess("", 255, "Control socket connect: Connection refused\n");
        default:
          return exitedProcess('{"credential":"LCL4R2TPHDKQ"}\n');
      }
    }),
  );

  // The real filesystem, watched where a master's life touches it.
  const fileSystem = Layer.effect(
    FileSystem.FileSystem,
    Effect.map(FileSystem.FileSystem, (fs) =>
      FileSystem.FileSystem.of({
        ...fs,
        exists: (path) =>
          Effect.suspend(() => {
            const authenticate = pendingSockets.get(path);
            pendingSockets.delete(path);
            authenticate?.();
            return fs.exists(path);
          }),
        // Synchronous for sockets, so a cleanup the test releases finishes
        // within a few scheduler turns instead of after unordered real I/O.
        remove: (path, options) =>
          path.endsWith(".sock")
            ? Effect.sync(() => NodeFS.rmSync(path, { force: true }))
            : fs.remove(path, options),
        writeFileString: (path, data, options) =>
          fs
            .writeFileString(path, data, options)
            .pipe(
              Effect.andThen(
                NodePath.basename(NodePath.dirname(path)).startsWith("auth-secret-")
                  ? Effect.sync(() => secretFilesWritten.push(path)).pipe(
                      Effect.andThen(input.secretWritten?.pass ?? Effect.void),
                    )
                  : Effect.void,
              ),
            ),
      }),
    ),
  ).pipe(Layer.provide(NodeServices.layer));

  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cm-"));
  /** `directory: null` builds a manager that was given no socket directory. */
  const layer = (options: { readonly directory?: string | null } = {}) =>
    Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      fileSystem,
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
        ),
      ),
      Layer.succeed(
        NetService.NetService,
        NetService.NetService.of({
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          // The tunnel's forward is up as soon as it is probed.
          hasListenerOnHost: () => Effect.succeed(true),
          reserveLoopbackPort: () => Effect.succeed(41_773),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
      ),
      input.prompt === undefined
        ? SshAuth.SshPasswordPrompt.disabledLayer
        : Layer.succeed(
            SshAuth.SshPasswordPrompt,
            SshAuth.SshPasswordPrompt.of({
              isAvailable: true,
              request: () =>
                Effect.sync(() => {
                  prompts += 1;
                  return input.prompt?.() ?? null;
                }),
            }),
          ),
      SshTunnel.SshEnvironmentManager.layer({
        resolveCliRunner: Effect.succeed(ARCHIVE),
        ...(options.directory === null
          ? {}
          : { controlSocketDirectory: options.directory ?? directory }),
      }),
    );

  const count = (event: string) => events.filter((entry) => entry === event).length;
  /**
   * Waits for the next ssh of `kind` to spawn, however much real I/O comes
   * first. Call it before starting the work so the spawn cannot be missed.
   */
  const nextSpawn = (kind: string) => {
    const spawned = new Promise<void>((resolve) => {
      spawnWaiters.set(kind, () => {
        spawnWaiters.delete(kind);
        resolve();
      });
    });
    return Effect.promise(() => spawned);
  };
  const argsOf = (kind: string) => spawned.filter((entry) => entry.kind === kind);
  return {
    events,
    spawned,
    secretFilesSeen,
    secretFilesWritten,
    crashLatestMaster: Effect.suspend(() => crashLatestMaster),
    directory,
    layer,
    count,
    argsOf,
    prompts: () => prompts,
    nextSpawn,
  };
};

function controlPathOf(args: ReadonlyArray<string>): string | undefined {
  return args.find((arg) => arg.startsWith("ControlPath="))?.slice("ControlPath=".length);
}

/** Lets a just-spawned step reach its timeout, then moves the clock past it. */
const passTimeout = (spawned: Effect.Effect<void>, duration: Duration.Input) =>
  Effect.gen(function* () {
    yield* spawned;
    for (let turn = 0; turn < 10; turn += 1) {
      yield* Effect.yieldNow;
    }
    yield* TestClock.adjust(duration);
  });

function optionValues(args: ReadonlyArray<string>, name: string): Array<string> {
  return args.filter((arg) => arg.startsWith(`${name}=`));
}

/** The fields of every Info-and-above log named `message`, in order. */
const captureLogs = () => {
  const entries: Array<{ readonly message: string; readonly fields: Record<string, unknown> }> = [];
  const logger = Logger.make(({ message }) => {
    const [text, fields] = Array.isArray(message) ? message : [message];
    entries.push({
      message: String(text),
      fields: typeof fields === "object" && fields !== null ? { ...fields } : {},
    });
  });
  return {
    entries,
    layer: Logger.layer([logger], { mergeWithExisting: false }),
    named: (message: string) =>
      entries.filter((entry) => entry.message === message).map((entry) => entry.fields),
  };
};

describe("owned control master", () => {
  it.effect("runs one-shots through an owned master and keeps the tunnel direct", () => {
    const harness = makeHarness({});
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* manager.ensureEnvironment(target, { issuePairingToken: true });

      const [master] = harness.argsOf("master");
      assert.isDefined(master);
      const socket = controlPathOf(master?.args ?? []);
      assert.isTrue(socket?.startsWith(`${harness.directory}/`));
      assert.isTrue(socket?.endsWith(".sock"));
      for (const option of [
        "ControlMaster=yes",
        "ControlPersist=no",
        "ServerAliveInterval=15",
        "ServerAliveCountMax=3",
      ]) {
        assert.include(master?.args, option);
      }
      assert.include(master?.args, "-N");
      // ssh keeps the first value of an option, so nothing may pin it earlier.
      assert.deepEqual(optionValues(master?.args ?? [], "ControlMaster"), ["ControlMaster=yes"]);

      for (const kind of ["launch", "script"]) {
        for (const entry of harness.argsOf(kind)) {
          assert.deepEqual(optionValues(entry.args, "ControlMaster"), ["ControlMaster=no"]);
          assert.deepEqual(optionValues(entry.args, "ControlPath"), [`ControlPath=${socket}`]);
        }
      }
      // A mux client's forward belongs to the master and outlives the client,
      // so the tunnel keeps its own connection and its exit still means "gone".
      const [tunnel] = harness.argsOf("tunnel");
      assert.deepEqual(optionValues(tunnel?.args ?? [], "ControlPath"), ["ControlPath=none"]);
      assert.deepEqual(harness.events, ["master", "launch", "tunnel", "script"]);
    }).pipe(Effect.provide(harness.layer()), Effect.scoped);
  });

  // A user master from ~/.ssh/config must never carry an environment command,
  // so each ssh the manager runs chooses its multiplexing explicitly.
  it.effect("pins multiplexing on every ssh it runs", () => {
    const harness = makeHarness({});
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* manager.ensureEnvironment(target, { issuePairingToken: true });
      yield* manager.ensureEnvironment(target, { issuePairingToken: true });
      yield* manager.disconnectEnvironment(target);
      // A socket left behind is reclaimed with `-O exit` before the next master.
      const socket = controlPathOf(harness.argsOf("master")[0]?.args ?? []) ?? "";
      NodeFS.writeFileSync(socket, "");
      yield* manager.ensureEnvironment(target);

      assert.includeMembers(
        harness.spawned.map((entry) => entry.kind),
        ["resolve", "master", "launch", "tunnel", "script", "probe", "control.exit"],
      );
      for (const entry of harness.spawned) {
        assert.lengthOf(optionValues(entry.args, "ControlMaster"), 1, entry.kind);
        assert.lengthOf(optionValues(entry.args, "ControlPath"), 1, entry.kind);
      }
    }).pipe(Effect.provide(harness.layer()), Effect.scoped);
  });

  it.effect("connects directly without a socket directory", () => {
    const harness = makeHarness({});
    const logs = captureLogs();
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* manager.ensureEnvironment(target, { issuePairingToken: true });

      assert.equal(harness.count("master"), 0);
      for (const entry of harness.spawned) {
        assert.deepEqual(optionValues(entry.args, "ControlPath"), ["ControlPath=none"]);
      }
      const [summary] = logs.named("ssh.environment.ensure.succeeded");
      assert.equal(summary?.controlMaster, "disabled");
    }).pipe(
      Effect.provide(Layer.merge(harness.layer({ directory: null }), logs.layer)),
      Effect.scoped,
    );
  });

  it.effect("never starts a master on Windows", () => {
    const harness = makeHarness({});
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* manager
        .ensureEnvironment(target, { issuePairingToken: true })
        .pipe(Effect.provideService(HostProcess.Platform, "win32"));

      assert.equal(harness.count("master"), 0);
      for (const entry of harness.spawned) {
        assert.deepEqual(optionValues(entry.args, "ControlPath"), ["ControlPath=none"]);
      }
    }).pipe(Effect.provide(harness.layer()), Effect.scoped);
  });

  it.effect(
    "moves the socket to a private temporary directory when the home path is too long",
    () => {
      const harness = makeHarness({});
      const longDirectory = `/${"d".repeat(90)}`;
      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(target);

        const socket = controlPathOf(harness.argsOf("master")[0]?.args ?? []) ?? "";
        assert.isTrue(socket.startsWith(NodeOS.tmpdir()));
        assert.isTrue((NodeFS.statSync(NodePath.dirname(socket)).mode & 0o077) === 0);
      }).pipe(Effect.provide(harness.layer({ directory: longDirectory })), Effect.scoped);
    },
  );

  it.effect("authenticates the master once and keeps the password out of its environment", () => {
    const harness = makeHarness({
      master: (attempt) =>
        attempt === 1
          ? { _tag: "exits", stderr: "devbox: Permission denied (publickey,password).\n" }
          : { _tag: "ready" },
      prompt: () => "hunter2",
    });
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* manager.ensureEnvironment(target, { issuePairingToken: true });

      assert.equal(harness.prompts(), 1);
      assert.equal(harness.count("master"), 2);
      const [, authenticated] = harness.argsOf("master");
      assert.isUndefined(authenticated?.env.LATHE_SSH_AUTH_SECRET);
      assert.deepEqual(
        harness.secretFilesSeen.map((file) => file.contents),
        ["hunter2\n"],
      );
      // Deleted once the master is up.
      for (const file of harness.secretFilesSeen) {
        assert.isFalse(NodeFS.existsSync(file.path));
      }
      assert.equal(harness.count("launch"), 1);
      assert.equal(harness.count("script"), 1);
    }).pipe(Effect.provide(harness.layer()), Effect.scoped);
  });

  it.effect("removes the askpass secret when the master start is interrupted", () => {
    const secretWritten = makeGate();
    const harness = makeHarness({
      master: (attempt) =>
        attempt === 1
          ? { _tag: "exits", stderr: "devbox: Permission denied (publickey,password).\n" }
          : { _tag: "ready" },
      prompt: () => "hunter2",
      secretWritten,
    });
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const ensure = yield* Effect.forkChild(manager.ensureEnvironment(target));
      // Interrupted the moment the secret is on disk, before the master spawns.
      yield* secretWritten.reached;
      const interrupt = yield* Effect.forkChild(Fiber.interrupt(ensure));
      for (let turn = 0; turn < 10; turn += 1) {
        yield* Effect.yieldNow;
      }
      yield* secretWritten.open;
      yield* Fiber.join(interrupt);

      assert.equal(harness.count("master"), 1);
      assert.lengthOf(harness.secretFilesWritten, 1);
      assert.isFalse(NodeFS.existsSync(harness.secretFilesWritten[0] ?? ""));
      assert.isFalse(NodeFS.existsSync(NodePath.dirname(harness.secretFilesWritten[0] ?? "")));
    }).pipe(Effect.provide(harness.layer()), Effect.scoped);
  });

  // A master that exits on its own is cleaned up outside the target lock, so
  // a new master may already listen at the same path when that cleanup runs.
  it.effect("keeps a new master's socket when a crashed master is cleaned up late", () => {
    const exitedMasterKill = makeGate();
    const harness = makeHarness({ exitedMasterKill });
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* manager.ensureEnvironment(target);
      const socket = controlPathOf(harness.argsOf("master")[0]?.args ?? []) ?? "";
      yield* harness.crashLatestMaster;
      // The crashed master's cleanup has started, and waits here.
      yield* exitedMasterKill.reached;

      yield* manager.ensureEnvironment(target, { issuePairingToken: true });
      assert.equal(harness.count("master"), 2);
      assert.equal(controlPathOf(harness.argsOf("master")[1]?.args ?? []), socket);

      yield* exitedMasterKill.open;
      for (let turn = 0; turn < 10; turn += 1) {
        yield* Effect.yieldNow;
      }

      assert.isTrue(NodeFS.existsSync(socket));
      // The new master still answers, so the next one-shot reuses it.
      yield* manager.ensureEnvironment(target, { issuePairingToken: true });
      assert.equal(harness.count("master"), 2);
    }).pipe(Effect.provide(harness.layer()), Effect.scoped);
  });

  it.effect("replaces a master whose health probe hangs", () => {
    const harness = makeHarness({ probe: (attempt) => (attempt === 1 ? "hang" : "ok") });
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* manager.ensureEnvironment(target);
      const probeSpawned = harness.nextSpawn("probe");
      const reconnect = yield* Effect.forkChild(
        manager.ensureEnvironment(target, { issuePairingToken: true }),
      );
      yield* passTimeout(probeSpawned, Duration.seconds(5));
      const result = yield* Fiber.join(reconnect);

      assert.equal(result.pairingToken, "LCL4R2TPHDKQ");
      assert.deepEqual(harness.events, [
        "master",
        "launch",
        "tunnel",
        "probe",
        "master.kill",
        "master",
        "script",
      ]);
      const sockets = harness.argsOf("master").map((entry) => controlPathOf(entry.args));
      assert.equal(sockets[0], sockets[1]);
    }).pipe(Effect.provide(harness.layer()), Effect.scoped);
  });

  it.effect("replaces the master when a command reports a broken mux", () => {
    const harness = makeHarness({
      launch: (attempt) =>
        attempt === 1
          ? {
              exitCode: 255,
              stderr: "mux_client_request_session: read from master failed: Broken pipe\n",
            }
          : { exitCode: 0 },
    });
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* manager.ensureEnvironment(target);

      assert.deepEqual(harness.events, [
        "master",
        "launch",
        "master.kill",
        "master",
        "launch",
        "tunnel",
      ]);
    }).pipe(Effect.provide(harness.layer()), Effect.scoped);
  });

  it.effect("stops the remote through the master, then tears the master down on disconnect", () => {
    const harness = makeHarness({});
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* manager.ensureEnvironment(target);
      harness.events.length = 0;
      yield* manager.disconnectEnvironment(target);

      assert.deepEqual(harness.events, ["tunnel.kill", "probe", "script", "master.kill"]);
      const socket = controlPathOf(harness.argsOf("master")[0]?.args ?? []);
      assert.deepEqual(optionValues(harness.argsOf("script")[0]?.args ?? [], "ControlPath"), [
        `ControlPath=${socket}`,
      ]);
      assert.isFalse(NodeFS.existsSync(socket ?? ""));
    }).pipe(Effect.provide(harness.layer()), Effect.scoped);
  });

  it.effect("stops owned masters when the manager shuts down", () => {
    const harness = makeHarness({});
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* manager.ensureEnvironment(target);
      assert.equal(harness.count("master.kill"), 0);
    }).pipe(
      Effect.provide(harness.layer()),
      Effect.scoped,
      Effect.andThen(
        Effect.sync(() => {
          assert.equal(harness.count("master.kill"), 1);
          // The remote stop runs before the master goes away.
          assert.isBelow(harness.events.indexOf("script"), harness.events.indexOf("master.kill"));
        }),
      ),
    );
  });

  it.effect("creates one master and one tunnel for concurrent ensures of one target", () => {
    const harness = makeHarness({});
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* Effect.all([manager.ensureEnvironment(target), manager.ensureEnvironment(target)], {
        concurrency: "unbounded",
      });

      assert.equal(harness.count("master"), 1);
      assert.equal(harness.count("tunnel"), 1);
    }).pipe(Effect.provide(harness.layer()), Effect.scoped);
  });

  it.effect("reclaims a socket left behind by an earlier run before starting a master", () => {
    const harness = makeHarness({});
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      // Learn the target's socket name, then simulate a crash that left it behind.
      yield* manager.ensureEnvironment(target);
      const socket = controlPathOf(harness.argsOf("master")[0]?.args ?? []) ?? "";
      yield* manager.disconnectEnvironment(target);
      NodeFS.writeFileSync(socket, "");
      harness.events.length = 0;

      yield* manager.ensureEnvironment(target);

      assert.deepEqual(harness.events, ["control.exit", "master", "launch", "tunnel"]);
    }).pipe(Effect.provide(harness.layer()), Effect.scoped);
  });

  it.effect.each([
    [
      "cannot listen on its socket",
      { _tag: "exits", stderr: "muxserver_listen: link mux listener: Operation not permitted\n" },
    ],
    [
      "has a socket path that is too long",
      {
        _tag: "exits",
        stderr:
          'unix_listener: path "/lathe/ssh/711bc738.sock.Xy" too long for Unix domain socket\n',
      },
    ],
    [
      "disables multiplexing and connects anyway",
      {
        _tag: "refuses",
        stderr: "ControlSocket /lathe/ssh/711bc738.sock already exists, disabling multiplexing\n",
      },
    ],
  ] as const)("falls back to direct commands for good when the master %s", ([, behavior]) => {
    const harness = makeHarness({ master: () => behavior });
    const logs = captureLogs();
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const masterSpawned = harness.nextSpawn("master");
      const first = yield* Effect.forkChild(manager.ensureEnvironment(target));
      if (behavior._tag === "refuses") {
        // The master keeps running; the readiness poll reads its stderr.
        yield* passTimeout(masterSpawned, Duration.millis(100));
      }
      yield* Fiber.join(first);
      yield* manager.ensureEnvironment(target, { issuePairingToken: true });

      assert.equal(harness.count("master"), 1);
      assert.equal(harness.count("master.kill"), behavior._tag === "refuses" ? 1 : 0);
      for (const kind of ["launch", "script", "tunnel"]) {
        for (const entry of harness.argsOf(kind)) {
          assert.deepEqual(optionValues(entry.args, "ControlPath"), ["ControlPath=none"]);
        }
      }
      assert.equal(harness.count("launch"), 1);
      assert.equal(harness.count("script"), 1);
      assert.deepEqual(
        logs
          .named("ssh.environment.ensure.succeeded")
          .map((summary) => [summary.controlMaster, summary.controlMasterReason]),
        [
          ["unavailable", "multiplexing-unsupported"],
          ["unavailable", "multiplexing-unsupported"],
        ],
      );
    }).pipe(Effect.provide(Layer.merge(harness.layer(), logs.layer)), Effect.scoped);
  });

  // A network blip or a wake from sleep says nothing about multiplexing, so
  // only that one ensure goes direct and the next tries a master again.
  it.effect.each([
    [
      "cannot reach the host",
      { _tag: "exits", stderr: "ssh: connect to host devbox port 22: Operation timed out\n" },
    ],
    [
      "loses its proxy",
      { _tag: "exits", stderr: "kex_exchange_identification: Connection closed by remote host\n" },
    ],
    ["never opens its socket", { _tag: "silent" }],
  ] as const)("falls back to direct commands for one ensure when the master %s", ([, behavior]) => {
    const harness = makeHarness({
      master: (attempt) => (attempt === 1 ? behavior : { _tag: "ready" }),
    });
    const logs = captureLogs();
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const masterSpawned = harness.nextSpawn("master");
      const first = yield* Effect.forkChild(manager.ensureEnvironment(target));
      if (behavior._tag === "silent") {
        yield* passTimeout(masterSpawned, Duration.seconds(30));
      }
      yield* Fiber.join(first);

      assert.equal(harness.count("master"), 1);
      for (const kind of ["launch", "tunnel"]) {
        for (const entry of harness.argsOf(kind)) {
          assert.deepEqual(optionValues(entry.args, "ControlPath"), ["ControlPath=none"]);
        }
      }

      yield* manager.ensureEnvironment(target, { issuePairingToken: true });

      assert.equal(harness.count("master"), 2);
      const socket = controlPathOf(harness.argsOf("master")[1]?.args ?? []);
      assert.deepEqual(optionValues(harness.argsOf("script")[0]?.args ?? [], "ControlPath"), [
        `ControlPath=${socket}`,
      ]);
      assert.deepEqual(
        logs
          .named("ssh.environment.ensure.succeeded")
          .map((summary) => [summary.controlMaster, summary.controlMasterReason]),
        [
          ["failed", "master-failed"],
          ["created", undefined],
        ],
      );
    }).pipe(Effect.provide(Layer.merge(harness.layer(), logs.layer)), Effect.scoped);
  });

  it.effect("summarizes each ensure and disconnect once, without any credential", () => {
    const harness = makeHarness({});
    const logs = captureLogs();
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* manager.ensureEnvironment(target, { issuePairingToken: true });
      yield* manager.ensureEnvironment(target);
      yield* manager.disconnectEnvironment(target);

      const ensures = logs.named("ssh.environment.ensure.succeeded");
      assert.lengthOf(ensures, 2);
      const [first, second] = ensures;
      assert.deepInclude(first, {
        alias: "devbox",
        tunnel: "created",
        controlMaster: "created",
        issuedPairingToken: true,
        launchAction: null,
        remoteServerKind: "managed",
        remotePort: 3773,
        localPort: 41_773,
      });
      assert.match(String(first?.stateKey), /^[0-9a-f]{16}$/u);
      for (const phase of [
        "totalMs",
        "targetResolveMs",
        "lockWaitMs",
        "controlMasterMs",
        "launchMs",
        "tunnelStartMs",
        "pairingMs",
      ]) {
        assert.isNumber(first?.[phase], phase);
      }
      // A healthy tunnel is reused without any one-shot, so no master is needed.
      assert.deepInclude(second, {
        tunnel: "reused",
        controlMaster: "not-used",
        issuedPairingToken: false,
      });
      assert.isNumber(second?.existingTunnelCheckMs);
      for (const phase of ["controlMasterMs", "launchMs", "tunnelStartMs", "pairingMs"]) {
        assert.notProperty(second ?? {}, phase);
      }

      const disconnects = logs.named("ssh.environment.disconnect.succeeded");
      assert.lengthOf(disconnects, 1);
      assert.deepInclude(disconnects[0], {
        alias: "devbox",
        tunnel: "closed",
        controlMaster: "reused",
      });
      for (const phase of ["totalMs", "tunnelCloseMs", "controlMasterMs", "remoteStopMs"]) {
        assert.isNumber(disconnects[0]?.[phase], phase);
      }
      assert.notInclude(JSON.stringify(logs.entries.map((entry) => entry.fields)), "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(Layer.merge(harness.layer(), logs.layer)), Effect.scoped);
  });
});
