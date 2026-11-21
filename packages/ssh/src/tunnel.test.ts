// @effect-diagnostics nodeBuiltinImport:off - Runs the generated runner in a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FORK_IDENTITY } from "@lathe/shared/forkIdentity";
import * as HostProcess from "@lathe/shared/HostProcess";
import * as NetService from "@lathe/shared/Net";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { captureLauncher, captureLauncherFor, runLauncher } from "./launcherTestHarness.ts";
import * as SshAuth from "./auth.ts";
import { remoteStateKey } from "./command.ts";
import { SshCommandError, SshPasswordPromptError, SshReadinessError } from "./errors.ts";
import { SshOutputObserver, type SshOutputChunk } from "./output.ts";
import * as SshTunnel from "./tunnel.ts";

const isSshCommandError = Schema.is(SshCommandError);

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(true),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args.map(String) : [];
}

// Only the launch passes arguments (its state key) to the remote sh.
const isLaunchCommand = (args: ReadonlyArray<string>) => / sh (?:-l )?-s -- /u.test(args.join(" "));

/** Keeps every Info-and-above log as its message and fields, for asserting what was logged. */
const captureLogs = () => {
  const entries: Array<{
    readonly level: string;
    readonly message: string;
    readonly fields: Readonly<Record<string, unknown>>;
  }> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    const [text, fields] = Array.isArray(message) ? message : [message];
    entries.push({
      level: logLevel,
      message: String(text),
      fields: typeof fields === "object" && fields !== null ? { ...fields } : {},
    });
  });
  return {
    entries,
    layer: Logger.layer([logger], { mergeWithExisting: false }),
    named: (message: string) => entries.filter((entry) => entry.message === message),
  };
};

const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;
const { cliBin } = FORK_IDENTITY;
const NODE_SCRIPT = {
  nodeScriptPath: "/Users/julius/Development/Work/codething-mvp/apps/server/dist/bin.mjs",
} as const;

// Emulates `t3 serve`: it takes the home owner lock at startup, then binds
// once a second server has tried the same home (or after 2s), so a concurrent
// launch always sees the home still unclaimed. Like the real server, it
// publishes server-runtime.json after it starts answering HTTP, if at all.
const fakeLatheServe = (publishDelayMs: number | null) => `const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const userdata = path.join(args[args.indexOf("--base-dir") + 1], "userdata");
const servers = path.join(process.env.HOME, "servers");
fs.mkdirSync(userdata, { recursive: true });
fs.appendFileSync(servers, process.pid + "\\n");
try {
  fs.writeFileSync(path.join(userdata, "server.lock"), String(process.pid), { flag: "wx" });
} catch {
  console.error("ServerAlreadyRunningError: another server owns " + userdata);
  process.exit(1);
}
setTimeout(() => process.exit(0), 60_000);
const serve = (tries) => {
  if (tries > 0 && fs.readFileSync(servers, "utf8").trim().split("\\n").length < 2) {
    setTimeout(() => serve(tries - 1), 50);
    return;
  }
  http.createServer((_, response) => response.end()).listen(port, "127.0.0.1", () => {
    const origin = "http://127.0.0.1:" + port;
    ${publishDelayMs === null ? "return;" : ""}
    setTimeout(() => {
      fs.writeFileSync(path.join(userdata, "server-runtime.json"), JSON.stringify({ pid: process.pid, port, origin }));
    }, ${publishDelayMs});
  });
};
serve(40);
`;

// The launch's POSIX bootstrap without the account login shell around it, so the
// test machine's login profile cannot move HOME.
const launchStateKey = (command: ChildProcess.Command) =>
  /exec sh -s -- ([^"]+)"/u.exec(commandArgs(command).join(" "))?.[1];

// Runs the remote half of an SSH launch as a local shell
// whose HOME is the given directory. Every launch after the first starts once
// a server is running (or after 10s), which lines up the race deterministically.
const localRemoteShellLayer = (home: string) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      let launches = 0;
      return ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return spawner.spawn(command);
        const gate =
          launches++ === 0
            ? ""
            : 'i=0; while [ ! -s "$HOME/servers" ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i+1)); done; ';
        return spawner.spawn(
          ChildProcess.make(
            "sh",
            ["-c", `${gate}exec sh -s -- "$1"`, "sh", launchStateKey(command) ?? ""],
            {
              ...command.options,
              env: { ...command.options.env, HOME: home },
              // Like an SSH session ending, the shell's exit leaves its nohup'd server running.
              detached: false,
            },
          ),
        );
      });
    }),
  );

describe("ssh tunnel scripts", () => {
  it.live("distinguishes an incompatible remote Node from a missing executable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-ssh-node-" });
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      for (const missing of [false, true]) {
        const nodeFixture = missing
          ? "command() { return 1; }; "
          : 'node() { cat >/dev/null; printf "Remote node 18.20.8 does not satisfy required range >=999.0.0.\\n" >&2; return 1; }; ';
        const remoteShell = ChildProcessSpawner.make((command) => {
          if (command._tag !== "StandardCommand") return spawner.spawn(command);
          return spawner.spawn(
            ChildProcess.make(
              "sh",
              ["-c", `${nodeFixture}eval "$(cat)"`, "sh", ...commandArgs(command).slice(-1)],
              {
                ...command.options,
                env: {
                  ...command.options.env,
                  HOME: home,
                  NVM_DIR: NodePath.join(home, ".nvm"),
                  FNM_DIR: NodePath.join(home, ".fnm"),
                  VOLTA_HOME: NodePath.join(home, ".volta"),
                },
              },
            ),
          );
        });
        const result = yield* SshTunnel.launchOrReuseRemoteServer(
          { alias: "devbox", hostname: "devbox", username: null, port: null },
          undefined,
          { nodeScriptPath: "/unused/server.ts", nodeEngineRange: ">=999.0.0" },
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, remoteShell),
          Effect.result,
        );
        assert.isTrue(Result.isFailure(result));
        if (!Result.isFailure(result)) return;
        assert.isTrue(isSshCommandError(result.failure));
        if (!isSshCommandError(result.failure)) return;
        assert.equal(result.failure.exitCode, 1);
        assert.equal(result.failure.stderr.includes("missing node on PATH"), missing);
        assert.equal(
          result.failure.stderr.includes("does not satisfy required range >=999.0.0"),
          !missing,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live("reports only the failed launch's own output, not an earlier launch's log", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-ssh-launch-log-" });
      const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
      const stateDir = NodePath.join(home, ".lathe", "ssh-launch", yield* remoteStateKey(target));
      const bin = NodePath.join(home, "bin");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.makeDirectory(bin);
      yield* fs.writeFileString(NodePath.join(stateDir, "server.log"), "EARLIER_LAUNCH\n");
      // The new server exits without output. Readiness then fails after a process from the
      // earlier launch writes through the log descriptor it still holds (fd 3).
      yield* fs.writeFileString(
        NodePath.join(bin, "node"),
        '#!/bin/sh\n[ "$1" = - ] || exit 0\ncat >/dev/null\ncase "$2" in\n  */port) echo 37731 ;;\n  37731) { printf "EARLIER_PROCESS\\n" >&3; } 2>/dev/null; exit 1 ;;\n  *) exit 1 ;;\nesac\n',
        { mode: 0o755 },
      );
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const remoteShell = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return spawner.spawn(command);
        return spawner.spawn(
          ChildProcess.make(
            "sh",
            [
              "-c",
              'exec 3>>"$1/server.log"; exec sh -s -- "$2"',
              "sh",
              stateDir,
              launchStateKey(command) ?? "",
            ],
            {
              ...command.options,
              env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` },
              extendEnv: false,
            },
          ),
        );
      });
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, {
        nodeScriptPath: "/unused/server.ts",
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, remoteShell),
        Effect.result,
      );
      assert.isTrue(Result.isFailure(result));
      if (!Result.isFailure(result)) return;
      assert.isTrue(isSshCommandError(result.failure));
      if (!isSshCommandError(result.failure)) return;
      assert.include(result.failure.stderr, "It wrote nothing to");
      assert.notInclude(result.failure.stderr, "EARLIER_LAUNCH");
      assert.notInclude(result.failure.stderr, "EARLIER_PROCESS");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it("rejects archive versions that are not a single exact version segment", () => {
    for (const archiveVersion of [
      "../other",
      "1.2.3/evil",
      "1.2.3\\evil",
      "1.2.3-preview.1 x",
      "1.2.3-preview.1\nrm -rf /",
      "v1.2.3",
    ]) {
      assert.throws(
        () => SshTunnel.buildRemoteLatheRunnerScript({ archiveVersion }),
        SshTunnel.SshInvalidArchiveVersionError,
        undefined,
        archiveVersion,
      );
    }
    assert.include(
      SshTunnel.buildRemoteLatheRunnerScript(ARCHIVE),
      "LATHE_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
  });

  it.each([
    { host: "Darwin x86_64", system: "Darwin", machine: "x86_64", downloads: false },
    { host: "Darwin arm64", system: "Darwin", machine: "arm64", downloads: true },
  ])(
    "only downloads a release archive the host can run: $host",
    ({ system, machine, downloads }) => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lathe-ssh-runner-"));
      try {
        const bin = NodePath.join(root, "bin");
        NodeFS.mkdirSync(bin);
        NodeFS.mkdirSync(NodePath.join(root, "home"));
        NodeFS.writeFileSync(
          NodePath.join(bin, "uname"),
          `#!/bin/sh\ncase "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; esac\n`,
          { mode: 0o755 },
        );
        NodeFS.writeFileSync(
          NodePath.join(bin, "curl"),
          "#!/bin/sh\necho 'download attempt' >&2\necho 'curl: (6) Could not resolve host: github.com' >&2\nexit 6\n",
          { mode: 0o755 },
        );
        const runner = NodePath.join(root, "run-lathe.sh");
        NodeFS.writeFileSync(runner, SshTunnel.buildRemoteLatheRunnerScript(ARCHIVE));
        const result = NodeChildProcess.spawnSync("sh", [runner, "--version"], {
          encoding: "utf8",
          env: { HOME: NodePath.join(root, "home"), PATH: `${bin}:${process.env.PATH ?? ""}` },
        });
        assert.notEqual(result.status, 0);
        if (downloads) {
          assert.include(result.stderr, "download attempt");
          // A bare curl error does not tell the user that t3 itself could not be downloaded.
          assert.include(result.stderr, ARCHIVE.archiveVersion);
          assert.include(result.stderr, "https://github.com/pingdotgg/t3code/releases/download");
        } else {
          assert.notInclude(result.stderr, "download attempt");
          assert.include(result.stderr, "has no t3 release archive.");
        }
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { installed: ARCHIVE.archiveVersion, status: 0, reuses: true },
    { installed: ARCHIVE.archiveVersion, status: 1, reuses: false },
    { installed: "9.9.9", status: 0, reuses: false },
  ])(
    "reuses a host CLI only at exactly the requested version: installed $installed, status $status",
    ({ installed, status, reuses }) => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lathe-ssh-runner-"));
      try {
        const bin = NodePath.join(root, "bin");
        NodeFS.mkdirSync(bin);
        NodeFS.mkdirSync(NodePath.join(root, "home"));
        // A host the release archive cannot run on, so only reuse can succeed.
        NodeFS.writeFileSync(
          NodePath.join(bin, "uname"),
          `#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo x86_64 ;; esac\n`,
          { mode: 0o755 },
        );
        NodeFS.writeFileSync(
          NodePath.join(bin, cliBin),
          `#!/bin/sh\ncase "$1" in --version) echo "${cliBin} v${installed}"; exit ${status} ;; *) echo "host ${cliBin} $*" ;; esac\n`,
          { mode: 0o755 },
        );
        const runner = NodePath.join(root, "run-lathe.sh");
        NodeFS.writeFileSync(runner, SshTunnel.buildRemoteLatheRunnerScript(ARCHIVE));
        const result = NodeChildProcess.spawnSync("sh", [runner, "serve"], {
          encoding: "utf8",
          env: { HOME: NodePath.join(root, "home"), PATH: `${bin}:${process.env.PATH ?? ""}` },
        });
        if (reuses) {
          assert.equal(result.status, 0);
          assert.equal(result.stdout, `host ${cliBin} serve\n`);
        } else {
          assert.notEqual(result.status, 0);
          assert.include(result.stderr, "has no t3 release archive.");
        }
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  // sha256sum and shasum escape a newline in a file name they print, so the home path has one.
  const checksumTools =
    NodeChildProcess.spawnSync("sh", ["-c", 'command -v "$1"', "sh", "shasum"]).status === 0
      ? ["sha256sum", "shasum"]
      : ["sha256sum"];
  it.each(checksumTools)("names missing gzip after verifying with %s", (checksum) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lathe-ssh-runner-"));
    try {
      const bin = NodePath.join(root, "bin");
      const release = NodePath.join(root, "release");
      const home = NodePath.join(root, "home\ncache");
      const archive = `t3-${ARCHIVE.archiveVersion}-linux-x64.tar.gz`;
      NodeFS.mkdirSync(bin);
      NodeFS.mkdirSync(home);
      NodeFS.mkdirSync(NodePath.join(release, "t3"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(release, "t3", "t3"), "#!/bin/sh\necho ok\n", {
        mode: 0o755,
      });
      NodeChildProcess.execFileSync("tar", ["-czf", archive, "t3"], { cwd: release });
      NodeChildProcess.execFileSync("sh", ["-c", `sha256sum ${archive} > SHA256SUMS`], {
        cwd: release,
      });
      for (const tool of [
        "sh",
        "mkdir",
        "mktemp",
        "cat",
        "rm",
        "grep",
        "cut",
        checksum,
        "tar",
        "mv",
      ]) {
        NodeFS.symlinkSync(
          NodeChildProcess.execFileSync("sh", ["-c", `command -v ${tool}`], {
            encoding: "utf8",
          }).trim(),
          NodePath.join(bin, tool),
        );
      }
      NodeFS.writeFileSync(
        NodePath.join(bin, "uname"),
        '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n',
        { mode: 0o755 },
      );
      NodeFS.writeFileSync(
        NodePath.join(bin, "curl"),
        `#!/bin/sh\nfor last; do :; done\nfor a; do case "$a" in http*) src="${release}/\${a##*/}" ;; esac; done\nexec cat "$src" > "$last"\n`,
        { mode: 0o755 },
      );
      const runner = NodePath.join(root, "run-lathe.sh");
      NodeFS.writeFileSync(runner, SshTunnel.buildRemoteLatheRunnerScript(ARCHIVE));
      const result = NodeChildProcess.spawnSync(NodePath.join(bin, "sh"), [runner, "--version"], {
        encoding: "utf8",
        env: { HOME: home, PATH: bin },
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /(missing|needs) gzip/);
      assert.notInclude(result.stderr, "Cannot exec");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("names missing tar before downloading the release archive", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lathe-ssh-runner-"));
    try {
      const bin = NodePath.join(root, "bin");
      const home = NodePath.join(root, "home");
      NodeFS.mkdirSync(bin);
      NodeFS.mkdirSync(home);
      for (const tool of ["sh", "mkdir", "mktemp", "cat", "rm"]) {
        NodeFS.symlinkSync(
          NodeChildProcess.execFileSync("sh", ["-c", `command -v ${tool}`], {
            encoding: "utf8",
          }).trim(),
          NodePath.join(bin, tool),
        );
      }
      NodeFS.writeFileSync(
        NodePath.join(bin, "uname"),
        '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n',
        { mode: 0o755 },
      );
      NodeFS.writeFileSync(
        NodePath.join(bin, "curl"),
        '#!/bin/sh\necho "download attempt" >&2\nexit 1\n',
        { mode: 0o755 },
      );
      const runner = NodePath.join(root, "run-lathe.sh");
      NodeFS.writeFileSync(runner, SshTunnel.buildRemoteLatheRunnerScript(ARCHIVE));
      const result = NodeChildProcess.spawnSync(NodePath.join(bin, "sh"), [runner, "--version"], {
        encoding: "utf8",
        env: { HOME: home, PATH: bin },
      });
      assert.notEqual(result.status, 0);
      assert.include(result.stderr, "needs tar");
      assert.notInclude(result.stderr, "download attempt");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n')),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
      layerSpawner,
    );

    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE);
      assert.equal(result.remotePort, 3774);
    }).pipe(Effect.provide(layerProcess));
  });

  // Pairing always follows a launch in the same ensure, so the runtime is
  // already installed and the default command budget applies.
  it.effect("gives pairing the default command timeout even for archive runners", () => {
    const target = { alias: "devbox", hostname: "devbox", username: null, port: null } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(makeRunningProcess(() => undefined)),
    );
    const layerProcess = Layer.merge(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.result(SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE)),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(60));
      const exit = fiber.pollUnsafe();

      assert.isDefined(exit);
      if (exit !== undefined && Exit.isSuccess(exit) && Result.isFailure(exit.value)) {
        assert.equal(exit.value.failure.message, "SSH command timed out after 60000ms.");
      } else {
        assert.fail("Pairing did not time out at 60s.");
      }
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "loads login settings without changing the POSIX bootstrap or its state key",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-ssh-login-" });
        const startupFile = `${directory}/bash-env`;
        const bash = `${directory}/bash`;
        // System profiles can reset HOME. Suppress profile reads while BASH_ENV
        // checks that the launcher still requests Bash login mode.
        yield* fs.writeFileString(bash, '#!/bin/sh\nexec /bin/bash --noprofile "$@"\n');
        yield* fs.chmod(bash, 0o755);
        yield* fs.writeFileString(
          startupFile,
          "if shopt -q login_shell; then export LATHE_SSH_LOGIN_ENV=loaded; fi\n",
        );
        const target = { alias: "login-test", hostname: "login-test", username: null, port: null };
        const remoteCommands: string[] = [];
        const capture = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            const args = commandArgs(command);
            remoteCommands.push(args.slice(args.indexOf(target.alias) + 1).join(" "));
            return makeSuccessfulProcess('{"remotePort":3774,"credential":"test"}\n');
          }),
        );
        yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, capture),
        );
        yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, capture),
        );
        yield* fs.writeFileString(
          `${directory}/.zprofile`,
          "if [[ -o login ]]; then export LATHE_SSH_LOGIN_ENV=loaded; fi\n",
        );
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const cases = [
          { shell: bash, outerShell: "/bin/sh", expected: "loaded" },
          { shell: "/bin/sh", outerShell: "/bin/sh", expected: "missing" },
          { shell: "", outerShell: "/bin/sh", expected: "missing" },
          { shell: "/unavailable/csh", outerShell: "/bin/sh", expected: "missing" },
          { shell: "/unavailable/tcsh", outerShell: "/bin/sh", expected: "missing" },
          { shell: "/unavailable/pwsh", outerShell: "/bin/sh", expected: "missing" },
        ];
        if (yield* fs.exists("/bin/zsh")) {
          cases.push({ shell: "/bin/zsh", outerShell: "/bin/zsh", expected: "loaded" });
        }
        if (yield* fs.exists("/bin/tcsh")) {
          cases.push({ shell: "/bin/tcsh", outerShell: "/bin/tcsh", expected: "missing" });
        }
        const environment = yield* HostProcess.Environment;
        for (const folder of (environment.PATH ?? "").split(":")) {
          const nu = `${folder}/nu`;
          if (folder && (yield* fs.exists(nu))) {
            cases.push({ shell: nu, outerShell: nu, expected: "missing" });
            break;
          }
        }
        for (const { shell, outerShell, expected, index, remoteCommand } of cases.flatMap((entry) =>
          remoteCommands.map((remoteCommand, index) => ({ ...entry, remoteCommand, index })),
        )) {
          const child = yield* spawner.spawn(
            ChildProcess.make(outerShell, ["-c", remoteCommand], {
              env: {
                PATH: environment.PATH ?? "/usr/bin:/bin",
                HOME: directory,
                XDG_CONFIG_HOME: directory,
                SHELL: shell,
                BASH_ENV: startupFile,
                ZDOTDIR: directory,
                LATHE_SSH_LOGIN_ENV: "",
              },
              stdin: {
                stream: Stream.make(
                  new TextEncoder().encode('printf "%s:%s" "${LATHE_SSH_LOGIN_ENV:-missing}" "$1"'),
                ),
                endOnDone: true,
              },
            }),
          );
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              child.stdout.pipe(
                Stream.decodeText(),
                Stream.runFold(
                  () => "",
                  (a, b) => a + b,
                ),
              ),
              child.stderr.pipe(
                Stream.decodeText(),
                Stream.runFold(
                  () => "",
                  (a, b) => a + b,
                ),
              ),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          assert.equal(Number(exitCode), 0, stderr);
          // First-run shell messages can precede the bootstrap response.
          const response = stdout.trim().split(/\r?\n/u).at(-1) ?? "";
          assert.match(
            response,
            new RegExp(index === 0 ? `^${expected}:[a-f0-9]{16}$` : `^${expected}:$`),
            shell || "unset SHELL",
          );
        }
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
      layerSpawner,
    );
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("retains a bounded diagnostic tail when the tunnel exits before readiness", () =>
    Effect.gen(function* () {
      const diagnostic = "Connection refused: café";
      const output = new TextEncoder().encode(
        "old diagnostics\n" + "x".repeat(32_768) + "\n" + diagnostic,
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(output.subarray(0, output.length - 1), output.subarray(-1)),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (isSshCommandError(result.failure)) {
            assert.equal(result.failure.exitCode, 1);
            assert.equal(result.failure.stderr.length, 16_384);
            assert.isTrue(result.failure.stderr.endsWith(diagnostic));
            assert.equal(result.failure.message, result.failure.stderr.trim());
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("reports the real exit when reading tunnel diagnostics fails", () =>
    Effect.gen(function* () {
      const diagnostic = "Permission denied (publickey)";
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(new TextEncoder().encode(diagnostic)).pipe(
                  Stream.concat(
                    Stream.fail(
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "Stream",
                        method: "read",
                        description: "stderr read failed",
                      }),
                    ),
                  ),
                ),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (isSshCommandError(result.failure)) {
            assert.equal(result.failure.exitCode, 255);
            assert.equal(result.failure.stderr, diagnostic);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("waits for a tunnel whose ssh connection outlasts the readiness timeout", () =>
    Effect.gen(function* () {
      const LOCAL_PORT = 41_773;
      // ssh spends ConnectTimeout on each unreachable address before the forward listens.
      const SSH_CONNECT_MS = 25_000;
      let forwardListensAt = Number.POSITIVE_INFINITY;
      const tunnelSpawned = yield* Deferred.make<void>();
      const forwardListening = (port: number) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => port === LOCAL_PORT && now >= forwardListensAt),
        );
      const spawner = ChildProcessSpawner.make((command) =>
        commandArgs(command).includes("-N")
          ? Effect.gen(function* () {
              forwardListensAt = (yield* Clock.currentTimeMillis) + SSH_CONNECT_MS;
              yield* Deferred.succeed(tunnelSpawned, undefined);
              return makeRunningProcess(() => undefined);
            })
          : Effect.succeed(makeSuccessfulProcess('{"remotePort":3773}\n')),
      );
      const httpClient = HttpClient.make((request) =>
        forwardListening(LOCAL_PORT).pipe(
          Effect.flatMap((listening) =>
            listening
              ? Effect.succeed(
                  HttpClientResponse.fromWeb(request, new Response("", { status: 200 })),
                )
              : Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      description: `connect ECONNREFUSED 127.0.0.1:${LOCAL_PORT}`,
                    }),
                  }),
                ),
          ),
        ),
      );
      const net = NetService.NetService.of({
        ...testNetService,
        reserveLoopbackPort: () => Effect.succeed(LOCAL_PORT),
        canListenOnHost: (port) =>
          forwardListening(port).pipe(Effect.map((listening) => !listening)),
        isPortAvailableOnLoopback: (port) =>
          forwardListening(port).pipe(Effect.map((listening) => !listening)),
        hasListenerOnHost: (port) => forwardListening(port),
      });
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, net),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const ensure = yield* Effect.forkChild(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        yield* Deferred.await(tunnelSpawned);
        yield* TestClock.adjust(Duration.seconds(60));
        const environment = yield* Fiber.join(ensure);
        assert.equal(environment.httpBaseUrl, `http://127.0.0.1:${LOCAL_PORT}/`);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each([
    // Over a ~1s RTT link each request through the forward takes a few round trips.
    { condition: "responses take over a second", reconnectResponseMs: 2_500 },
    // An alive server whose event loop stalls (e.g. on a blocked fsync) answers late.
    { condition: "server stalls for 20 seconds", reconnectResponseMs: 20_000 },
    // ssh closes the forwarded connection when nothing listens on the remote port.
    { condition: "server is gone", reconnectResponseMs: 0, serverGone: true },
  ])("connects and reuses a tunnel whose $condition", ({ reconnectResponseMs, serverGone }) =>
    Effect.gen(function* () {
      const RESPONSE_MS = 2_500;
      const tunnelSpawned = yield* Deferred.make<void>();
      const reconnectProbed = yield* Deferred.make<void>();
      const forwardReplaced = yield* Deferred.make<void>();
      let forwards = 0;
      let connected = false;
      const spawner = ChildProcessSpawner.make((command) =>
        commandArgs(command).includes("-N")
          ? Effect.sync(() => ++forwards).pipe(
              Effect.flatMap((count) =>
                Deferred.succeed(count === 1 ? tunnelSpawned : forwardReplaced, undefined),
              ),
              Effect.as(makeRunningProcess(() => undefined)),
            )
          : Effect.succeed(makeSuccessfulProcess('{"remotePort":3773}\n')),
      );
      const httpClient = HttpClient.make((request) =>
        Effect.gen(function* () {
          if (connected) yield* Deferred.succeed(reconnectProbed, undefined);
          yield* Effect.sleep(Duration.millis(connected ? reconnectResponseMs : RESPONSE_MS));
          if (connected && serverGone) {
            return yield* new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                description: "socket hang up",
              }),
            });
          }
          return HttpClientResponse.fromWeb(request, new Response("", { status: 200 }));
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, httpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const ensure = yield* Effect.forkChild(
          Effect.result(
            manager.ensureEnvironment({
              alias: "devbox",
              hostname: "devbox",
              username: null,
              port: null,
            }),
          ),
        );
        yield* Deferred.await(tunnelSpawned);
        yield* TestClock.adjust(Duration.seconds(60));
        const result = yield* Fiber.join(ensure);
        assert.isTrue(
          Result.isSuccess(result),
          Result.isFailure(result) ? result.failure.message : undefined,
        );
        if (Result.isFailure(result)) return;

        connected = true;
        const reconnect = yield* Effect.forkChild(manager.ensureEnvironment(result.success.target));
        yield* Deferred.await(reconnectProbed);
        yield* TestClock.adjust(Duration.seconds(60));
        const outcome = yield* Effect.raceFirst(
          Fiber.join(reconnect).pipe(Effect.map((environment) => environment.httpBaseUrl)),
          Deferred.await(forwardReplaced).pipe(Effect.as("replaced the forward")),
        );
        assert.equal(outcome, serverGone ? "replaced the forward" : result.success.httpBaseUrl);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("reconnects a saved alias through the port its ssh config names now", () =>
    Effect.gen(function* () {
      let configPort = 53_791;
      const tunnelPorts: Array<string | undefined> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        const args = commandArgs(command);
        if (args.includes("-G")) {
          return Effect.succeed(
            makeSuccessfulProcess(`hostname 127.0.0.1\nuser developer\nport ${configPort}\n`),
          );
        }
        if (args.includes("-N")) {
          tunnelPorts.push(args[args.indexOf("-p") + 1]);
          return Effect.succeed(makeRunningProcess(() => undefined));
        }
        return Effect.succeed(makeSuccessfulProcess('{"remotePort":3773}\n'));
      });
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const added = yield* manager.ensureEnvironment({
          alias: "lima-sandbox",
          hostname: "lima-sandbox",
          username: null,
          port: null,
        });
        // The VM restarts on a new port; the client reconnects with the target it saved.
        yield* manager.disconnectEnvironment(added.target);
        configPort = 53_812;
        yield* manager.ensureEnvironment(added.target);
        assert.deepStrictEqual(tunnelPorts, ["53791", "53812"]);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("fails with a readiness error when ssh never connects", () =>
    Effect.gen(function* () {
      const tunnelSpawned = yield* Deferred.make<void>();
      let tunnelKilled = false;
      const spawner = ChildProcessSpawner.make((command) =>
        commandArgs(command).includes("-N")
          ? Deferred.succeed(tunnelSpawned, undefined).pipe(
              Effect.as(
                makeRunningProcess(() => {
                  tunnelKilled = true;
                }),
              ),
            )
          : Effect.succeed(makeSuccessfulProcess('{"remotePort":3773}\n')),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(
          NetService.NetService,
          NetService.NetService.of({
            ...testNetService,
            hasListenerOnHost: () => Effect.succeed(false),
          }),
        ),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const ensure = yield* Effect.forkChild(
          Effect.result(
            manager.ensureEnvironment({
              alias: "devbox",
              hostname: "devbox",
              username: null,
              port: null,
            }),
          ),
        );
        yield* Deferred.await(tunnelSpawned);
        yield* TestClock.adjust(Duration.minutes(2));
        const result = yield* Fiber.join(ensure);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshReadinessError);
          assert.include(result.failure.message, "SSH connection to devbox did not come up");
        }
        assert.isTrue(tunnelKilled);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each([
    {
      name: "does not ask for a password when the agent cannot sign an accepted key",
      stderr:
        'sign_and_send_pubkey: signing failed for ED25519 "/home/julius/.ssh/id_ed25519" from agent: communication with agent failed\r\n' +
        "julius@devbox: Permission denied (publickey,password).\r\n",
      expectedPromptAttempts: [],
    },
    {
      name: "asks for a password when signing failure has no agent provenance",
      stderr:
        'sign_and_send_pubkey: signing failed for ED25519-CERT "key-cert.pub": agent refused operation\n' +
        "julius@devbox: Permission denied (publickey,password).\n",
      expectedPromptAttempts: [1],
    },
    {
      name: "does not ask for a password when the host key cannot be verified",
      stderr: "Host key verification failed.\r\n",
      expectedPromptAttempts: [],
    },
    {
      name: "asks for a password when the server rejects every key",
      stderr: "julius@devbox: Permission denied (publickey,password).\r\n",
      expectedPromptAttempts: [1],
    },
  ])("$name", ({ stderr, expectedPromptAttempts }) =>
    Effect.gen(function* () {
      const promptAttempts: Array<number> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-G")
            ? makeSuccessfulProcess("")
            : {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(new TextEncoder().encode(stderr)),
              },
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        Layer.succeed(
          SshAuth.SshPasswordPrompt,
          SshAuth.SshPasswordPrompt.of({
            isAvailable: true,
            request: (request) =>
              Effect.sync(() => {
                promptAttempts.push(request.attempt);
                return null;
              }),
          }),
        ),
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        assert.deepEqual(promptAttempts, expectedPromptAttempts);
        if (Result.isFailure(result)) {
          if (expectedPromptAttempts.length === 0) {
            assert.instanceOf(result.failure, SshCommandError);
            if (isSshCommandError(result.failure)) {
              assert.equal(result.failure.stderr, stderr);
            }
          } else {
            assert.instanceOf(result.failure, SshPasswordPromptError);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each(["local tunnel", "remote server"] as const)(
    "waits for %s shutdown before reconnecting the same target",
    (stalledStep) =>
      Effect.gen(function* () {
        const shutdownStarted = yield* Deferred.make<void>();
        const finishShutdown = yield* Deferred.make<void>();
        const reconnectsStarted = yield* Deferred.make<void>();
        const pauseShutdown = Deferred.succeed(shutdownStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishShutdown)),
        );
        let resolutions = 0;
        let launches = 0;
        let tunnels = 0;
        let stops = 0;
        let remoteRunning = false;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = commandArgs(command);
            const isTarget = args.includes(target.alias);
            if (args.includes("-G")) {
              if (isTarget && ++resolutions === 4) {
                yield* Deferred.succeed(reconnectsStarted, undefined);
              }
              return makeSuccessfulProcess("");
            }
            if (args.includes("-N")) {
              const tunnel = makeRunningProcess(() => undefined);
              if (isTarget && ++tunnels === 1 && stalledStep === "local tunnel") {
                return {
                  ...tunnel,
                  kill: (options?: ChildProcess.KillOptions) =>
                    pauseShutdown.pipe(Effect.andThen(tunnel.kill(options))),
                };
              }
              return tunnel;
            }
            if (args.includes("-c")) {
              if (isTarget) {
                launches += 1;
                remoteRunning = true;
              }
              return makeSuccessfulProcess('{"remotePort":3773}\n');
            }
            const stop = makeSuccessfulProcess('{"stopped":true}\n');
            if (!isTarget) return stop;
            const pause = ++stops === 1 && stalledStep === "remote server";
            return {
              ...stop,
              exitCode: (pause ? pauseShutdown : Effect.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    remoteRunning = false;
                    return ChildProcessSpawner.ExitCode(0);
                  }),
                ),
              ),
            };
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(target);
          const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
          yield* Deferred.await(shutdownStarted);
          const firstReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          const secondReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          yield* Deferred.await(reconnectsStarted);

          yield* manager.ensureEnvironment({
            alias: "other",
            hostname: "other",
            username: null,
            port: null,
          });
          yield* TestClock.adjust(Duration.zero);
          const launchesBeforeShutdown = launches;
          yield* Deferred.succeed(finishShutdown, undefined);
          yield* Fiber.join(disconnect);
          const first = yield* Fiber.join(firstReconnect);
          const second = yield* Fiber.join(secondReconnect);

          assert.equal(launchesBeforeShutdown, 1);
          assert.equal(launches, 2);
          assert.equal(tunnels, 2);
          assert.isTrue(remoteRunning);
          assert.equal(first.httpBaseUrl, second.httpBaseUrl);
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishShutdown, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );

  it.live("concurrent launches on one remote home record the server that owns it", () =>
    // The second row's server never publishes server-runtime.json.
    Effect.forEach([1_500, null, "wrapper"] as const, (variant) =>
      Effect.gen(function* () {
        const publishDelayMs = variant === "wrapper" ? 0 : variant;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-ssh-launch-" });
        const serversFile = path.join(home, "servers");
        yield* Effect.addFinalizer(() =>
          fs.readFileString(serversFile).pipe(
            Effect.map((pids) => {
              for (const pid of pids.split("\n").filter(Boolean)) {
                try {
                  process.kill(Number(pid), "SIGKILL");
                } catch {}
              }
            }),
            Effect.ignore,
          ),
        );
        const serverScript = path.join(home, "fake-lathe.cjs");
        yield* fs.writeFileString(serverScript, fakeLatheServe(publishDelayMs));
        const wrapperScript = path.join(home, "wrapper.cjs");
        yield* fs.writeFileString(
          wrapperScript,
          `const child = require("node:child_process").spawn(process.execPath, [${JSON.stringify(serverScript)}, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));`,
        );
        // A launch that died holding the lock must not block or double-admit later ones.
        const launchLock = path.join(home, ".lathe", "ssh-launch", ".launch.lock");
        yield* fs.makeDirectory(path.dirname(launchLock), { recursive: true });
        yield* fs.writeFileString(launchLock, "999999999\n");
        const targets = [
          { alias: "devbox", hostname: "devbox", username: null, port: null },
          { alias: "devbox-tailnet", hostname: "devbox-tailnet", username: null, port: null },
        ];

        const launches = yield* Effect.forEach(
          targets,
          (target) =>
            SshTunnel.launchOrReuseRemoteServer(target, undefined, {
              nodeScriptPath: variant === "wrapper" ? wrapperScript : serverScript,
            }),
          { concurrency: "unbounded" },
        ).pipe(Effect.provide(localRemoteShellLayer(home)));

        const ownerPid = Number(
          yield* fs.readFileString(path.join(home, ".lathe", "userdata", "server.lock")),
        );
        assert.sameMembers(
          launches.map((launch) => launch.remoteServerKind),
          ["managed", "external"],
        );
        assert.equal(launches[0]!.remotePort, launches[1]!.remotePort);
        assert.deepEqual((yield* fs.readFileString(serversFile)).trim().split("\n"), [
          String(ownerPid),
        ]);
        for (const [index, launch] of launches.entries()) {
          if (launch.remoteServerKind !== "managed") continue;
          const stateKey = yield* remoteStateKey(targets[index]!);
          const recordedPid = yield* fs.readFileString(
            path.join(home, ".lathe", "ssh-launch", stateKey, "pid"),
          );
          assert.equal(
            Number(recordedPid.trim()),
            ownerPid,
            `${targets[index]!.alias} reported a managed server, but its recorded PID is not the server that owns the remote home`,
          );
        }
        assert.isFalse(yield* fs.exists(launchLock));
      }).pipe(Effect.scoped),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  describe("dead tunnels", () => {
    const target = { alias: "devbox", hostname: "devbox", username: null, port: null };

    /** Records each ssh step in order; tunnels exit on kill or when the test says so. */
    const recordingLayer = (input: { readonly isHealthy: () => boolean }) => {
      const events: Array<string> = [];
      const logs = captureLogs();
      const tunnelExits: Array<Deferred.Deferred<ChildProcessSpawner.ExitCode>> = [];
      const tunnelCloses: Array<Deferred.Deferred<void>> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const args = commandArgs(command);
          if (args.includes("-G")) return makeSuccessfulProcess("");
          if (args.includes("-N")) {
            events.push("tunnel");
            const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
            const closed = yield* Deferred.make<void>();
            tunnelExits.push(exited);
            tunnelCloses.push(closed);
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(123),
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              exitCode: Deferred.await(exited),
              isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
              kill: () =>
                Effect.sync(() => events.push("tunnel.kill")).pipe(
                  Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(143))),
                  Effect.andThen(Deferred.succeed(closed, undefined)),
                ),
              stdin: Sink.drain,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            });
          }
          if (isLaunchCommand(args)) {
            events.push("launch");
            return makeSuccessfulProcess('{"remotePort":3773,"serverKind":"managed"}\n');
          }
          events.push("stop");
          return makeSuccessfulProcess('{"stopped":true}\n');
        }),
      );
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          events.push("http");
          return HttpClientResponse.fromWeb(
            request,
            new Response("", { status: input.isHealthy() ? 200 : 503 }),
          );
        }),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, http),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        logs.layer,
      );
      return { events, tunnelExits, tunnelCloses, layer, logs };
    };

    it.effect("closes a stale tunnel without stopping the remote server it reconnects to", () => {
      let broken = false;
      const count = (event: string) => events.filter((entry) => entry === event).length;
      // A broken first tunnel stops answering, as when a network drop leaves the
      // ssh child alive; the replacement tunnel answers.
      const { events, layer, logs } = recordingLayer({
        isHealthy: () => !broken || count("tunnel") === 2,
      });
      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(target);
        broken = true;
        const reconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
        // Past the 5-second readiness probe of the existing tunnel.
        yield* TestClock.adjust(Duration.seconds(6));
        yield* Fiber.join(reconnect);

        assert.equal(count("stop"), 0);
        assert.equal(count("tunnel.kill"), 1);
        assert.equal(count("launch"), 2);
        assert.equal(count("tunnel"), 2);
        const summaries = logs.named("ssh.environment.ensure.succeeded");
        assert.deepEqual(
          summaries.map((entry) => entry.fields.tunnel),
          ["created", "stale-replaced"],
        );
        assert.notProperty(summaries[0]?.fields ?? {}, "existingTunnelCheckMs");
        assert.isAtLeast(Number(summaries[1]?.fields.existingTunnelCheckMs), 5_000);
      }).pipe(
        Effect.provide(layer),
        Effect.scoped,
        // Shutting the manager down still stops the server it owns, exactly once.
        Effect.andThen(
          Effect.sync(() => {
            assert.equal(count("stop"), 1);
            assert.equal(count("tunnel.kill"), 2);
          }),
        ),
      );
    });

    it.effect("forgets a tunnel whose ssh process exits so the next ensure starts fresh", () => {
      const { events, tunnelExits, tunnelCloses, layer, logs } = recordingLayer({
        isHealthy: () => true,
      });
      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(target);
        const [firstExit] = tunnelExits;
        const [firstClosed] = tunnelCloses;
        if (firstExit === undefined || firstClosed === undefined) {
          return yield* Effect.die(new Error("The first ensure spawned no tunnel."));
        }
        events.length = 0;

        // Fails with a timeout, rather than hanging, if nothing prunes the entry.
        const pruned = yield* Effect.forkChild(
          Deferred.await(firstClosed).pipe(Effect.timeout(Duration.seconds(1))),
        );
        yield* Deferred.succeed(firstExit, ChildProcessSpawner.ExitCode(255));
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Fiber.join(pruned);
        // Pruning closes the dead entry but never stops the remote server.
        assert.deepEqual(events, ["tunnel.kill"]);
        events.length = 0;

        yield* manager.ensureEnvironment(target);

        assert.deepEqual(events, ["launch", "tunnel", "http"]);
        assert.deepEqual(
          logs.named("ssh.environment.ensure.succeeded").map((entry) => entry.fields.tunnel),
          ["created", "pruned-exited"],
        );
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    /** Ensures the target, then lets its tunnel's ssh exit and waits until it is pruned. */
    const ensureThenLoseTunnel = (input: {
      readonly tunnelExits: ReadonlyArray<Deferred.Deferred<ChildProcessSpawner.ExitCode>>;
      readonly tunnelCloses: ReadonlyArray<Deferred.Deferred<void>>;
    }) =>
      Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        yield* manager.ensureEnvironment(target);
        const [exit] = input.tunnelExits;
        const [closed] = input.tunnelCloses;
        if (exit === undefined || closed === undefined) {
          return yield* Effect.die(new Error("The ensure spawned no tunnel."));
        }
        const pruned = yield* Effect.forkChild(
          Deferred.await(closed).pipe(Effect.timeout(Duration.seconds(1))),
        );
        yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(255));
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Fiber.join(pruned);
        return manager;
      });

    // Quitting the app stops the managed servers it started, as it did before
    // dead tunnels were pruned from the manager.
    it.effect("stops a managed server whose tunnel died once the manager shuts down", () => {
      const recording = recordingLayer({ isHealthy: () => true });
      const count = (event: string) => recording.events.filter((entry) => entry === event).length;
      return ensureThenLoseTunnel(recording).pipe(
        Effect.tap(() => Effect.sync(() => assert.equal(count("stop"), 0))),
        Effect.provide(recording.layer),
        Effect.scoped,
        Effect.andThen(Effect.sync(() => assert.equal(count("stop"), 1))),
      );
    });

    it.effect("does not stop a disconnected server again when the manager shuts down", () => {
      const recording = recordingLayer({ isHealthy: () => true });
      const count = (event: string) => recording.events.filter((entry) => entry === event).length;
      return ensureThenLoseTunnel(recording).pipe(
        Effect.flatMap((manager) => manager.disconnectEnvironment(target)),
        Effect.tap(() => Effect.sync(() => assert.equal(count("stop"), 1))),
        Effect.provide(recording.layer),
        Effect.scoped,
        Effect.andThen(Effect.sync(() => assert.equal(count("stop"), 1))),
      );
    });
  });
});

describe("ssh environment output", () => {
  const target = {
    alias: "devbox",
    hostname: "devbox.example.com",
    username: "julius",
    port: 2222,
  } as const;
  const encode = (text: string) => Stream.make(new TextEncoder().encode(text));
  const makeExitedProcess = (input: {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly exitCode?: number;
  }) =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(123),
      stdout: input.stdout === undefined ? Stream.empty : encode(input.stdout),
      stderr: input.stderr === undefined ? Stream.empty : encode(input.stderr),
      all: Stream.empty,
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  const REMOTE_LOG = "Error: listen EADDRINUSE 127.0.0.1:3773\n";

  /** Routes each ssh invocation by its shape: resolve, tunnel, launch, or a bare script. */
  const managerLayer = (input: {
    readonly launch: () => ChildProcessSpawner.ChildProcessHandle;
    readonly tunnel?: () => ChildProcessSpawner.ChildProcessHandle;
    readonly http?: HttpClient.HttpClient;
    readonly runner?: typeof ARCHIVE | typeof NODE_SCRIPT;
  }) =>
    Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            const args = commandArgs(command);
            if (args.includes("-G")) return makeExitedProcess({ stdout: "\n" });
            if (args.includes("-N")) return input.tunnel?.() ?? makeRunningProcess(() => {});
            if (isLaunchCommand(args)) return input.launch();
            // Pairing and the log tail are both bare `sh -s` scripts. A pairing answer
            // that leaked would show up as its credential in the observed output.
            return makeExitedProcess({
              stdout: `${REMOTE_LOG}{"credential":"LCL4R2TPHDKQ"}\n`,
            });
          }),
        ),
      ),
      Layer.succeed(HttpClient.HttpClient, input.http ?? testHttpClient),
      Layer.succeed(NetService.NetService, testNetService),
      SshAuth.SshPasswordPrompt.disabledLayer,
      SshTunnel.SshEnvironmentManager.layer({
        resolveCliRunner: Effect.succeed(input.runner ?? ARCHIVE),
      }),
      TestClock.layer(),
    );

  const observed = () => {
    const chunks: Array<SshOutputChunk> = [];
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(SshOutputObserver, (chunk) =>
          Effect.sync(() => {
            chunks.push(chunk);
          }),
        ),
      );
    return { chunks, provide };
  };

  it.effect("reports launch output while connecting, but never the pairing credential", () => {
    const { chunks, provide } = observed();
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* provide(manager.ensureEnvironment(target, { issuePairingToken: true }));

      assert.deepInclude(chunks, {
        source: "launch",
        stream: "stderr",
        text: "installing t3 1.2.3\n",
      });
      assert.deepInclude(chunks, {
        source: "launch",
        stream: "stdout",
        text: '{"remotePort":3773}\n',
      });
      assert.isFalse(chunks.some((chunk) => chunk.text.includes("LCL4R2TPHDKQ")));
    }).pipe(
      Effect.provide(
        managerLayer({
          launch: () =>
            makeExitedProcess({
              stdout: '{"remotePort":3773}\n',
              stderr: "installing t3 1.2.3\n",
            }),
        }),
      ),
    );
  });

  it.effect("reads the remote server log when a launch times out", () => {
    const { chunks, provide } = observed();
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const fiber = yield* Effect.forkChild(
        Effect.result(provide(manager.ensureEnvironment(target))),
      );
      yield* Effect.yieldNow;
      // Well past the node-script launch timeout, which covers lock, update and owner waits.
      yield* TestClock.adjust(Duration.hours(1));
      const result = yield* Fiber.join(fiber);

      assert.isTrue(Result.isFailure(result));
      assert.deepInclude(chunks, {
        source: "remote-log",
        stream: "stdout",
        text: `${REMOTE_LOG}{"credential":"LCL4R2TPHDKQ"}\n`,
      });
      const summary = chunks.find((chunk) => chunk.source === "tunnel");
      assert.match(summary?.text ?? "", /^Failed after (\d+\.\d)s; slowest step: launch \1s\n$/);
    }).pipe(
      Effect.provide(
        managerLayer({ launch: () => makeRunningProcess(() => {}), runner: NODE_SCRIPT }),
      ),
    );
  });

  // A reconnect over a live tunnel runs no launch, so this line is all it reports.
  it.effect("summarizes each connect, including one that reuses its tunnel", () => {
    const { chunks, provide } = observed();
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* provide(manager.ensureEnvironment(target));
      const first = chunks.splice(0);
      yield* provide(manager.ensureEnvironment(target));

      assert.deepInclude(first, {
        source: "tunnel",
        stream: "stdout",
        text: "Connected in 0.0s: opened a tunnel from local port 41773 to remote port 3773\n",
      });
      assert.deepEqual(chunks, [
        {
          source: "tunnel",
          stream: "stdout",
          text: "Connected in 0.0s: reused the tunnel from local port 41773 to remote port 3773\n",
        },
      ]);
    }).pipe(
      Effect.provide(
        managerLayer({
          launch: () => makeExitedProcess({ stdout: '{"remotePort":3773}\n' }),
        }),
      ),
    );
  });

  it.effect("reports the tunnel's own error and the remote log when the tunnel dies", () => {
    const { chunks, provide } = observed();
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const result = yield* Effect.result(provide(manager.ensureEnvironment(target)));

      assert.isTrue(Result.isFailure(result));
      assert.deepInclude(chunks, {
        source: "tunnel",
        stream: "stderr",
        text: "channel 2: open failed: connect failed: Connection refused\n",
      });
      assert.isTrue(chunks.some((chunk) => chunk.source === "remote-log"));
    }).pipe(
      Effect.provide(
        managerLayer({
          launch: () => makeExitedProcess({ stdout: '{"remotePort":3773}\n' }),
          tunnel: () =>
            makeExitedProcess({
              stderr: "channel 2: open failed: connect failed: Connection refused\n",
              exitCode: 255,
            }),
          http: hangingHttpClient,
        }),
      ),
    );
  });

  it.effect.each([
    ["reused", "Remote server reused on port 3773"],
    ["started", "Remote server started on port 3773"],
    ["restarted-runner-changed", "Remote server restarted on port 3773: runner changed"],
    ["adopted-external", "Using the external remote server on port 3773"],
    [
      "replaced-by-external",
      "Stopped the managed remote server, using the external one on port 3773",
    ],
    ["reused-external", "External remote server reused on port 3773"],
  ] as const)("reports a %s launch in the output and the ready log", ([action, line]) => {
    const { chunks, provide } = observed();
    const logs = captureLogs();
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* provide(manager.ensureEnvironment(target));

      assert.deepInclude(chunks, { source: "launch", stream: "stdout", text: `${line}\n` });
      const [ready] = logs.named("ssh.remoteServer.launch.ready");
      assert.equal(ready?.fields.launchAction, action);
      const [succeeded] = logs.named("ssh.environment.ensure.succeeded");
      assert.equal(succeeded?.fields.launchAction, action);
    }).pipe(
      Effect.provide(
        Layer.merge(
          managerLayer({
            launch: () =>
              makeExitedProcess({
                stdout: `{"remotePort":3773,"serverKind":"managed","action":"${action}"}\n`,
              }),
          }),
          logs.layer,
        ),
      ),
    );
  });

  it.effect("accepts a launch answer without an action and reports none", () => {
    const { chunks, provide } = observed();
    const logs = captureLogs();
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      yield* provide(manager.ensureEnvironment(target));

      assert.deepEqual(
        chunks.filter((chunk) => chunk.source === "launch").map((chunk) => chunk.text),
        ['{"remotePort":3773}\n'],
      );
      const [ready] = logs.named("ssh.remoteServer.launch.ready");
      assert.isNull(ready?.fields.launchAction);
    }).pipe(
      Effect.provide(
        Layer.merge(
          managerLayer({ launch: () => makeExitedProcess({ stdout: '{"remotePort":3773}\n' }) }),
          logs.layer,
        ),
      ),
    );
  });

  it.effect("summarizes a failed ensure once, with the phases that ran and the error", () => {
    const logs = captureLogs();
    return Effect.gen(function* () {
      const manager = yield* SshTunnel.SshEnvironmentManager;
      const result = yield* Effect.result(manager.ensureEnvironment(target));

      assert.isTrue(Result.isFailure(result));
      assert.lengthOf(logs.named("ssh.environment.ensure.succeeded"), 0);
      const failed = logs.named("ssh.environment.ensure.failed");
      assert.lengthOf(failed, 1);
      const fields = failed[0]?.fields ?? {};
      assert.equal(failed[0]?.level, "Info");
      assert.equal(fields.alias, "devbox");
      assert.equal(fields.errorTag, "SshCommandError");
      assert.include(String(fields.errorMessage), "Connection refused");
      assert.equal(fields.tunnel, "created");
      assert.equal(fields.launchAction, "started");
      assert.equal(fields.remotePort, 3773);
      assert.equal(fields.issuedPairingToken, false);
      for (const phase of ["targetResolveMs", "lockWaitMs", "launchMs", "tunnelStartMs"]) {
        assert.isNumber(fields[phase], phase);
      }
      assert.notProperty(fields, "existingTunnelCheckMs");
      assert.notProperty(fields, "pairingMs");
    }).pipe(
      Effect.provide(
        Layer.merge(
          managerLayer({
            launch: () =>
              makeExitedProcess({
                stdout: '{"remotePort":3773,"serverKind":"managed","action":"started"}\n',
              }),
            tunnel: () =>
              makeExitedProcess({
                stderr: "channel 2: open failed: connect failed: Connection refused\n",
                exitCode: 255,
              }),
            http: hangingHttpClient,
          }),
          logs.layer,
        ),
      ),
    );
  });
});

const runScript = (home: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const hostEnv = yield* HostProcess.Environment;
    const child = yield* spawner.spawn(
      ChildProcess.make("sh", args, {
        env: { PATH: hostEnv.PATH ?? "", HOME: home },
        extendEnv: false,
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (acc, chunk) => acc + chunk,
          ),
        ),
        child.stderr.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (acc, chunk) => acc + chunk,
          ),
        ),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode };
  });

describe("archive runner script", () => {
  const hostPlatform = HostProcess.Platform.defaultValue();
  const hostArch = HostProcess.Architecture.defaultValue();
  const windowsHost = hostPlatform === "win32";
  const archiveVersion = "1.2.3-preview.20260911.4";

  const runRunner = (home: string, runner: string) => runScript(home, [runner, "--version"]);

  // Fork: a current release publishes lathe-* and t3-* archives holding `lathe` and `t3`; a
  // pre-rename release has only t3-* holding `t3`. The current t3-* asset is a pre-rename archive
  // and each executable names itself, so the output shows which asset and executable the runner
  // chose.
  const makeMirror = Effect.fn("makeMirror")(function* (
    root: string,
    release_: "current" | "pre-rename" = "current",
  ) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = hostPlatform === "darwin" ? "darwin" : "linux";
    const arch = hostArch === "arm64" ? "arm64" : "x64";
    const stem = `t3-${archiveVersion}-${platform}-${arch}`;
    const stage = `${root}/stage/${stem}`;
    const legacyStage = `${root}/legacy-stage/${stem}`;
    const release = `${root}/mirror/v${archiveVersion}`;
    const asset = `${platform}-${arch}.tar.gz`;
    const sums = (names: ReadonlyArray<string>) =>
      `cd '${release}' && (sha256sum ${names.join(" ")} 2>/dev/null || shasum -a 256 ${names.join(" ")}) > SHA256SUMS`;
    const script = [
      "set -eu",
      `mkdir -p '${stage}' '${legacyStage}' '${release}'`,
      `printf '#!/bin/sh\\necho t3 v${archiveVersion}\\n' > '${legacyStage}/t3'`,
      `chmod +x '${legacyStage}/t3'`,
      `tar -czf '${release}/t3-${archiveVersion}-${asset}' -C '${root}/legacy-stage' '${stem}'`,
      ...(release_ === "current"
        ? [
            `printf '#!/bin/sh\\necho lathe v${archiveVersion}\\n' > '${stage}/lathe'`,
            `printf '#!/bin/sh\\necho alias t3 v${archiveVersion}\\n' > '${stage}/t3'`,
            `chmod +x '${stage}/lathe' '${stage}/t3'`,
            `tar -czf '${release}/lathe-${archiveVersion}-${asset}' -C '${root}/stage' '${stem}'`,
            sums([`'t3-${archiveVersion}-${asset}'`, `'lathe-${archiveVersion}-${asset}'`]),
          ]
        : [sums([`'t3-${archiveVersion}-${asset}'`])]),
    ].join("\n");
    const child = yield* spawner.spawn(ChildProcess.make("sh", ["-c", script]));
    assert.equal(Number(yield* child.exitCode), 0);
    return `file://${root}/mirror`;
  });

  // Fork: a remote reached by this release installs from a release published
  // before the Lathe rename, which only has t3-* assets holding `t3`.
  it.effect.skipIf(windowsHost)("installs and runs a release published before the rename", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-archive-runner-" });
      const releaseBaseUrl = yield* makeMirror(root, "pre-rename");
      const runner = `${root}/run-lathe.sh`;
      yield* fs.writeFileString(
        runner,
        SshTunnel.buildRemoteLatheRunnerScript({ archiveVersion, releaseBaseUrl }),
      );
      const home = `${root}/home`;
      yield* fs.makeDirectory(home, { recursive: true });

      const result = yield* runRunner(home, runner);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout.trim(), `t3 v${archiveVersion}`);
      assert.isFalse(yield* fs.exists(`${home}/.lathe/runtime/versions/${archiveVersion}/lathe`));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // Fork: a runtime an older runner unpacked holds only `t3`; it is complete,
  // so it runs as it is with nothing downloaded.
  it.effect.skipIf(windowsHost)(
    "runs a runtime an older runner unpacked without reinstalling it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-archive-runner-" });
        const runner = `${root}/run-lathe.sh`;
        yield* fs.writeFileString(
          runner,
          SshTunnel.buildRemoteLatheRunnerScript({
            archiveVersion,
            releaseBaseUrl: `file://${root}/no-mirror`,
          }),
        );
        const home = `${root}/home`;
        const runtime = `${home}/.lathe/runtime/versions/${archiveVersion}`;
        yield* fs.makeDirectory(runtime, { recursive: true });
        yield* fs.writeFileString(`${runtime}/t3`, `#!/bin/sh\necho old t3 v${archiveVersion}\n`);
        yield* fs.chmod(`${runtime}/t3`, 0o755);
        yield* fs.writeFileString(`${runtime}/.launcher`, "exe\n");
        yield* fs.writeFileString(`${runtime}/.install-complete`, `${archiveVersion}\n`);

        const result = yield* runRunner(home, runner);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stdout.trim(), `old t3 v${archiveVersion}`);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  // Fork: a remote that still runs from the pre-rename base directory keeps
  // using it, so its running server, state and runtimes stay together.
  it.effect.skipIf(windowsHost)(
    "keeps installing into a pre-rename base directory that is still in use",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-archive-runner-" });
        const releaseBaseUrl = yield* makeMirror(root);
        const runner = `${root}/run-lathe.sh`;
        yield* fs.writeFileString(
          runner,
          SshTunnel.buildRemoteLatheRunnerScript({ archiveVersion, releaseBaseUrl }),
        );
        const home = `${root}/home`;
        yield* fs.makeDirectory(`${home}/.t3f`, { recursive: true });

        const result = yield* runRunner(home, runner);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.deepEqual(yield* fs.readDirectory(`${home}/.t3f/runtime/versions`), [
          archiveVersion,
        ]);
        assert.isFalse(yield* fs.exists(`${home}/.lathe`));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// On Linux kill -0 accepts a thread ID and kill <tid> signals its whole process,
// but ps lists only thread-group leaders. After a reboot the managed pid file can
// name a thread or a whole process that is not our server.
describe.runIf(HostProcess.Platform.defaultValue() === "linux")("stale managed pid file", () => {
  const FAKE_SERVER = `const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const server = http.createServer((request, response) => {
  // Closes the listener but stays up, like a server stuck in its teardown.
  if (request.url === "/stop") {
    server.close();
    setInterval(() => {}, 1 << 30);
    response.setHeader("connection", "close");
  }
  response.end("ok");
});
server.listen(Number(flag("--port") ?? 0), "127.0.0.1", () => {
  const port = server.address().port;
  const base = flag("--base-dir");
  if (base) {
    fs.mkdirSync(path.join(base, "userdata"), { recursive: true });
    fs.writeFileSync(
      path.join(base, "userdata", "server-runtime.json"),
      JSON.stringify({ version: 1, pid: process.pid, port, origin: "http://127.0.0.1:" + port }),
    );
  }
  console.log(port);
});
`;
  const target = { alias: "devbox", hostname: "devbox", username: null, port: null } as const;
  const staleIds = ["a thread of an unrelated process", "an unrelated process"] as const;

  const isRunning = (pid: number) =>
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(`/proc/${pid}/stat`)).pipe(
      Effect.map((stat) => !/^\d+ \(.*\) Z/u.test(stat)),
      Effect.orElseSucceed(() => false),
    );

  const prepare = (staleId: (typeof staleIds)[number]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-stale-pid-" });
      const home = `${root}/home`;
      const fakeServer = `${root}/fake-lathe.cjs`;
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.writeFileString(fakeServer, FAKE_SERVER);
      // Runs the remote command locally under the temp HOME. setsid keeps a launched server alive
      // when the command's process group goes away, as sshd would.
      const sshAsLocalShell = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand" || command.command !== "ssh") {
          return realSpawner.spawn(command);
        }
        if (command.args.includes("-G")) return Effect.succeed(makeSuccessfulProcess(""));
        const stateKey = launchStateKey(command);
        const remoteArgs =
          stateKey === undefined
            ? command.args.slice(command.args.indexOf("--") + 2)
            : ["sh", "-s", "--", ...stateKey.split(" ")];
        return realSpawner.spawn(
          ChildProcess.make("setsid", ["-w", ...remoteArgs], {
            ...command.options,
            env: { PATH: process.env.PATH ?? "", HOME: home },
            extendEnv: false,
          }),
        );
      });
      const holder = yield* realSpawner.spawn(ChildProcess.make("node", [fakeServer]));
      const holderPort = Number(
        Option.getOrThrow(
          yield* holder.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead),
        ),
      );
      const tid = Number(
        (yield* fs.readDirectory(`/proc/${holder.pid}/task`)).find(
          (task) => task !== `${holder.pid}`,
        ),
      );
      assert.isTrue(Number.isInteger(tid));
      return {
        fs,
        home,
        fakeServer,
        holder,
        holderPort,
        sshAsLocalShell,
        staleId: staleId === "an unrelated process" ? holder.pid : tid,
        stateDir: `${home}/.lathe/ssh-launch/${yield* remoteStateKey(target)}`,
      };
    });

  it.live.each(staleIds)("launches a fresh server when the managed pid file names %s", (kind) =>
    Effect.gen(function* () {
      const { fs, home, fakeServer, holderPort, sshAsLocalShell, staleId, stateDir } =
        yield* prepare(kind);
      const launch = SshTunnel.launchOrReuseRemoteServer(target, undefined, {
        nodeScriptPath: fakeServer,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, sshAsLocalShell));
      const readPid = fs
        .readFileString(`${stateDir}/pid`)
        .pipe(Effect.map((pid) => Number(pid.trim())));
      const launchedPids: Array<number> = [];
      yield* Effect.addFinalizer(() =>
        Effect.forEach(launchedPids, (pid) =>
          Effect.sync(() => {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }),
        ),
      );

      const first = yield* launch;
      const firstPid = yield* readPid;
      launchedPids.push(firstPid);
      // Fork: the answer also says whether the launch started or reused the server.
      assert.deepEqual(yield* launch, { ...first, launchAction: "reused" });
      assert.equal(yield* readPid, firstPid);

      // Reboot: our server is gone and its recorded PID now names something that
      // answers on the recorded port.
      process.kill(firstPid, "SIGKILL");
      yield* fs.remove(`${home}/.lathe/userdata/server-runtime.json`);
      yield* fs.writeFileString(`${stateDir}/pid`, `${staleId}\n`);
      yield* fs.writeFileString(`${stateDir}/port`, `${holderPort}\n`);

      const relaunched = yield* launch;
      const pid = yield* readPid;
      if (pid !== staleId) launchedPids.push(pid);
      assert.notEqual(
        relaunched.remotePort,
        holderPort,
        `the launcher kept ${kind} as its running server`,
      );
      assert.isTrue(yield* isRunning(pid));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live("a reconnect names the previous server while it is still shutting down", () =>
    Effect.gen(function* () {
      const { fs, fakeServer, sshAsLocalShell, stateDir } = yield* prepare("an unrelated process");
      const launch = SshTunnel.launchOrReuseRemoteServer(target, undefined, {
        nodeScriptPath: fakeServer,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, sshAsLocalShell));

      const first = yield* launch;
      const pid = Number((yield* fs.readFileString(`${stateDir}/pid`)).trim());
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }),
      );
      yield* HttpClient.get(`http://127.0.0.1:${first.remotePort}/stop`).pipe(
        Effect.flatMap((response) => response.text),
        Effect.provide(FetchHttpClient.layer),
      );

      const error = yield* Effect.flip(launch);
      assert.include(
        error.message,
        `The previous remote Lathe server (PID ${pid}) is still shutting down.`,
      );
      assert.isTrue(yield* isRunning(pid), "the launcher signalled the stopping server");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live("an update replaces the managed server after its connection is renamed", () =>
    Effect.gen(function* () {
      const { fs, home, fakeServer, sshAsLocalShell, stateDir } =
        yield* prepare("an unrelated process");
      const updatedServer = `${home}/fake-lathe-next.cjs`;
      yield* fs.writeFileString(updatedServer, FAKE_SERVER);
      const renamed = { ...target, alias: "devbox-renamed" };
      const launch = (
        launchTarget: typeof renamed,
        nodeScriptPath: string,
        launcherId: string | null = "a".repeat(32),
      ) =>
        SshTunnel.launchOrReuseRemoteServer(
          launchTarget,
          undefined,
          { nodeScriptPath },
          launcherId,
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, sshAsLocalShell));
      const runtimePid = fs
        .readFileString(`${home}/.lathe/userdata/server-runtime.json`)
        .pipe(Effect.map((runtime) => Number(JSON.parse(runtime).pid)));
      const launchedPids: Array<number> = [];
      yield* Effect.addFinalizer(() =>
        Effect.forEach(launchedPids, (pid) =>
          Effect.sync(() => {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }),
        ),
      );

      assert.equal((yield* launch(target, fakeServer)).remoteServerKind, "managed");
      const originalPid = yield* runtimePid;
      launchedPids.push(originalPid);

      // Another desktop on another version shares the server; it must not take it over.
      const otherDesktop = yield* launch(
        { ...target, alias: "devbox-other" },
        updatedServer,
        "b".repeat(32),
      );
      assert.equal(otherDesktop.remoteServerKind, "external");
      assert.isTrue(yield* isRunning(originalPid), "another desktop replaced the server");

      const afterRename = yield* launch(renamed, fakeServer);
      assert.equal(yield* runtimePid, originalPid, "renaming alone restarted the server");
      assert.equal(
        yield* fs.readFileString(`${stateDir}/managed`),
        "external\n",
        "the old alias still owns the server, so its disconnect would stop it",
      );
      const afterUpdate = yield* launch(renamed, updatedServer);
      launchedPids.push(yield* runtimePid);
      assert.deepEqual(
        [afterRename.remoteServerKind, afterUpdate.remoteServerKind],
        ["managed", "managed"],
      );
      assert.isFalse(
        yield* isRunning(originalPid),
        "the update left the server launched under the old alias running",
      );

      // A rename and an update in one reconnect still replace the server.
      const updatedPid = yield* runtimePid;
      const renamedAndUpdated = yield* launch({ ...target, alias: "devbox-again" }, fakeServer);
      launchedPids.push(yield* runtimePid);
      assert.equal(renamedAndUpdated.remoteServerKind, "managed");
      assert.isFalse(yield* isRunning(updatedPid), "a rename with an update kept the old server");

      // A server that a launch without an ID started under a reused key is not this desktop's.
      const again = { ...target, alias: "devbox-again" };
      process.kill(yield* runtimePid, "SIGKILL");
      assert.equal((yield* launch(again, fakeServer, null)).remoteServerKind, "managed");
      const unownedPid = yield* runtimePid;
      launchedPids.push(unownedPid);
      const final = yield* launch({ ...target, alias: "devbox-final" }, updatedServer);
      assert.equal(final.remoteServerKind, "external");
      assert.isTrue(yield* isRunning(unownedPid), "a stale launcher ID claimed another's server");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.live.each(staleIds)("disconnecting does not signal %s named by the managed pid file", (kind) =>
    Effect.gen(function* () {
      const { fs, holder, sshAsLocalShell, staleId, stateDir } = yield* prepare(kind);
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(`${stateDir}/pid`, `${staleId}\n`);
      yield* fs.writeFileString(`${stateDir}/managed`, "managed\n");
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, sshAsLocalShell),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );

      yield* Effect.flatMap(SshTunnel.SshEnvironmentManager, (manager) =>
        manager.disconnectEnvironment(target),
      ).pipe(Effect.provide(layer));
      assert.isTrue(yield* isRunning(holder.pid), `disconnecting signalled ${kind}`);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});

// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too.

// Reuse decisions live in generated shell, so drive the real launch script in
// a temporary HOME. Each archive version gets a pre-installed fake runtime
// whose server writes the default runtime file the way `t3 serve` does.
describe("archive launch script", () => {
  const windowsHost = HostProcess.Platform.defaultValue() === "win32";
  const FAKE_Lathe = `const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const [version, ...args] = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const probe = (port) =>
  new Promise((resolve) => {
    http
      .get({ hostname: "127.0.0.1", port, path: "/", timeout: 1000 }, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      })
      .once("error", () => resolve(false));
  });
const canBind = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
(async () => {
  if (args[0] === "--version") return console.log(version);
  if (args[0] === "serve") {
    const server = http.createServer((_request, response) => response.end("ok"));
    server.listen(Number(flag("--port")), "127.0.0.1", () => {
      const port = server.address().port;
      const userdata = path.join(flag("--base-dir"), "userdata");
      fs.mkdirSync(userdata, { recursive: true });
      fs.writeFileSync(
        path.join(userdata, "server-runtime.json"),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          port,
          origin: "http://127.0.0.1:" + port,
          startedAt: new Date().toISOString(),
          serverVersion: version,
        }),
      );
    });
    return;
  }
  const [helper, a, b, c] = args.slice(1);
  if (helper === "pick-port") {
    const start = Number(fs.existsSync(a) ? fs.readFileSync(a, "utf8") : b);
    for (let port = start; port < start + Number(c); port += 1) {
      if (await canBind(port)) return process.stdout.write(String(port));
    }
  } else if (helper === "wait-ready") {
    const deadline = Date.now() + Number(b);
    while (Date.now() < deadline) {
      if (await probe(Number(a))) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } else if (helper === "runtime-port") {
    try {
      const runtime = JSON.parse(fs.readFileSync(a, "utf8"));
      process.kill(runtime.pid, 0);
      return process.stdout.write(runtime.pid + " " + runtime.port);
    } catch {}
  } else if (helper === "keep-server") {
    try {
      const runtime = JSON.parse(fs.readFileSync(a, "utf8"));
      const order = runtime.serverVersion.localeCompare(version, "en", { numeric: true });
      if (String(runtime.pid) === b && order >= 0) return;
    } catch {}
  }
  process.exitCode = 1;
})();
`;

  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const freeLoopbackPort = Effect.callback<number>((resume) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        resume(Effect.succeed(typeof address === "object" && address ? address.port : 0)),
      );
    });
  });

  const runScript = (home: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(ChildProcess.make("sh", args, { env: { HOME: home } }));
      const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
        stream.pipe(Stream.decodeText(), Stream.mkString);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, exitCode };
    });

  // Installs a fake runtime per version so the runner never downloads. The
  // seeded remembered port keeps the test off the default 3773, which a live
  // Lathe on this machine may own.
  const prepareLaunch = (versions: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-archive-launch-" });
      const home = `${root}/home`;
      const stateDir = `${home}/.lathe/ssh-launch/test-state`;
      const fakeLathe = `${root}/fake-lathe.cjs`;
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(`${stateDir}/port`, `${yield* freeLoopbackPort}\n`);
      yield* fs.writeFileString(fakeLathe, FAKE_Lathe);
      for (const version of versions) {
        const runtimeDir = `${home}/.lathe/runtime/versions/${version}`;
        yield* fs.makeDirectory(runtimeDir, { recursive: true });
        yield* fs.writeFileString(
          `${runtimeDir}/t3`,
          `#!/bin/sh\nexec node '${fakeLathe}' '${version}' "$@"\n`,
        );
        yield* fs.chmod(`${runtimeDir}/t3`, 0o755);
        yield* fs.writeFileString(`${runtimeDir}/.install-complete`, `${version}\n`);
      }
      const readManagedPid = fs
        .readFileString(`${stateDir}/pid`)
        .pipe(Effect.map((pid) => Number(pid.trim())));
      const readServerVersion = fs
        .readFileString(`${home}/.lathe/userdata/server-runtime.json`)
        .pipe(Effect.map((raw) => (JSON.parse(raw) as { serverVersion: string }).serverVersion));
      // Launched servers outlive the script, so stop each PID it recorded.
      const launchedPids = new Set<number>();
      yield* Effect.addFinalizer(() =>
        readManagedPid.pipe(
          Effect.map((pid) => [...launchedPids, pid]),
          Effect.orElseSucceed(() => [...launchedPids]),
          Effect.map((pids) => {
            for (const pid of pids) {
              if (isAlive(pid)) process.kill(pid, "SIGKILL");
            }
          }),
        ),
      );
      const connect = (archiveVersion: string) =>
        Effect.gen(function* () {
          const launch = `${root}/launch-${archiveVersion}.sh`;
          yield* fs.writeFileString(launch, SshTunnel.buildRemoteLaunchScript({ archiveVersion }));
          const result = yield* runScript(home, [launch, "test-state"]);
          assert.equal(result.exitCode, 0, result.stderr);
          const pid = yield* readManagedPid;
          launchedPids.add(pid);
          return pid;
        });
      return { connect, readManagedPid, readServerVersion };
    });

  it.live.skipIf(windowsHost)(
    "a reconnect from an older client keeps a newer managed server running",
    () =>
      Effect.gen(function* () {
        const { connect, readServerVersion } = yield* prepareLaunch(["0.1.5", "0.1.6"]);
        const newerPid = yield* connect("0.1.6");
        assert.equal(yield* readServerVersion, "0.1.6");

        const pidAfterOlderClient = yield* connect("0.1.5");
        assert.isTrue(
          isAlive(newerPid),
          "the 0.1.6 managed server was killed by a 0.1.5 reconnect",
        );
        assert.equal(pidAfterOlderClient, newerPid);
        assert.equal(yield* readServerVersion, "0.1.6");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  // An NFS home can carry a ~/.lathe symlink whose target exists only on another host.
  it.live.skipIf(windowsHost)("launches through a ~/.lathe symlink whose target is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "lathe-dangling-home-" });
      const home = `${root}/home`;
      const target = `${root}/shared/t3`;
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.symlink(target, `${home}/.lathe`);
      const launch = `${root}/launch.sh`;
      yield* fs.writeFileString(
        launch,
        SshTunnel.buildRemoteLaunchScript({
          archiveVersion: "0.1.6",
          releaseBaseUrl: "http://127.0.0.1:9",
        }),
      );
      const result = yield* runScript(home, [launch, "test-state"]);
      assert.notInclude(result.stderr, "File exists");
      assert.isTrue(yield* fs.exists(`${target}/ssh-launch/test-state`), result.stderr);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(windowsHost)("a newer client still replaces an older managed server", () =>
    Effect.gen(function* () {
      const { connect, readServerVersion } = yield* prepareLaunch(["0.1.5", "0.1.6"]);
      const olderPid = yield* connect("0.1.5");

      const newerPid = yield* connect("0.1.6");
      assert.notEqual(newerPid, olderPid);
      assert.isFalse(isAlive(olderPid));
      assert.equal(yield* readServerVersion, "0.1.6");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("SSH launch during desktop update", () => {
  it.effect("archive launcher reuses the replacement without host Node", () =>
    Effect.gen(function* () {
      const script = yield* captureLauncherFor({ archiveVersion: "1.2.3" });
      const result = runLauncher(script, {
        archive: true,
        marker: { startedAt: 0, expiresAt: 60_000 },
        readyAt: 2_000,
      });
      assert.deepInclude(result.output, { remotePort: 4888, serverKind: "external" });
      assert.equal(result.now, 2_000);
      assert.isFalse(result.events.some((event) => event.startsWith("start ")));
    }),
  );

  it.effect.each(["managed", "external"] as const)(
    "reuses recorded %s server without runtime metadata or an update wait",
    (recordedKind) =>
      Effect.gen(function* () {
        const result = runLauncher(yield* captureLauncher, {
          marker: { startedAt: 0, expiresAt: 60_000 },
          recordedKind,
        });
        assert.deepInclude(result.output, { remotePort: 5999, serverKind: recordedKind });
        assert.equal(result.now, 0);
        assert.isFalse(result.events.some((event) => event.startsWith("kill ")));
        assert.isFalse(result.events.some((event) => event.startsWith("start ")));
      }),
  );

  it.effect.each([
    ["malformed", "broken"],
    ["future", { startedAt: 1_000, expiresAt: 61_000 }],
    ["expired", { startedAt: -60_000, expiresAt: 0 }],
  ] as const)("preserves %s markers without waiting", ([, marker]) =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, { marker });
      assert.equal(result.now, 0);
      assert.isTrue(result.markerExists);
      assert.deepInclude(result.output, { remotePort: 5999, serverKind: "managed" });
    }),
  );

  it.effect("bounds the wait when the host clock jumps back", () =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, {
        marker: { startedAt: 0, expiresAt: 60_000 },
        clockJump: -30_000,
      });
      assert.deepInclude(result.output, { remotePort: 5999, serverKind: "managed" });
      assert.isBelow(result.events.filter((event) => event.startsWith("runtime ")).length, 62);
    }),
  );

  it.effect("refreshes runtime after readiness removes the marker between polls", () =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, {
        marker: { startedAt: 0, expiresAt: 60_000 },
        readyAt: 8_000,
        clearMarkerOnReady: true,
      });
      assert.deepInclude(result.output, { remotePort: 4888, serverKind: "external" });
      assert.equal(result.now, 8_000);
      assert.isFalse(result.markerExists);
      assert.isFalse(result.events.some((event) => event.startsWith("start ")));
      assert.isFalse(result.events.some((event) => event.startsWith("kill ")));
    }),
  );

  it.effect("reuses a runtime published before the first marker read", () =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, {
        marker: { startedAt: 0, expiresAt: 60_000 },
        publishAfterFirstRuntimeRead: true,
      });
      assert.deepInclude(result.output, { remotePort: 4888, serverKind: "external" });
      assert.equal(result.now, 0);
      assert.isFalse(result.events.some((event) => event.startsWith("start ")));
    }),
  );

  it.effect("waits across the eight-second installer gap and reuses the replacement server", () =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, {
        marker: { startedAt: 0, expiresAt: 60_000 },
        readyAt: 8_000,
      });
      assert.deepInclude(result.output, { remotePort: 4888, serverKind: "external" });
      assert.equal(result.now, 8_000);
      assert.isFalse(result.events.some((event) => event.startsWith("start ")));
      assert.isAtLeast(result.events.filter((event) => event.startsWith("runtime ")).length, 2);
    }),
  );

  it.effect("keeps waiting while a stale runtime record points at a dead port", () =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, {
        marker: { startedAt: 0, expiresAt: 60_000 },
        initialPort: 3773,
        readyAt: 3_000,
      });
      assert.deepInclude(result.output, { remotePort: 4888, serverKind: "external" });
      assert.equal(result.now, 3_000);
      assert.isFalse(result.events.some((event) => event.startsWith("start ")));
    }),
  );

  it.effect("starts a server when the marker expires without a replacement becoming ready", () =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, {
        marker: { startedAt: 0, expiresAt: 60_000 },
      });
      assert.deepInclude(result.output, { remotePort: 5999, serverKind: "managed" });
      assert.isAtLeast(result.now, 60_000);
      assert.isAtMost(result.now, 61_000);
      assert.isTrue(result.markerExists, "an expired marker is ignored, not deleted");
      assert.equal(result.events.filter((event) => event.startsWith("start ")).length, 1);
    }),
  );

  it.effect.each([false, true])(
    "waits for a boot service between two servers (archive: %s)",
    (archive) =>
      Effect.gen(function* () {
        const script = yield* archive
          ? captureLauncherFor({ archiveVersion: "1.2.3" })
          : captureLauncher;
        const result = runLauncher(script, { archive, serviceServing: true, readyAt: 5_000 });
        assert.deepInclude(result.output, { remotePort: 4888, serverKind: "external" });
        assert.equal(result.now, 5_000);
        assert.isFalse(result.events.some((event) => event.startsWith("start ")));
      }),
  );

  it.effect("fails without starting a second server when the home's owner never answers", () =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, {
        serviceServing: true,
        allowFailure: true,
      });
      assert.equal(result.status, 1);
      assert.include(result.stderr, "no second server was started");
      assert.equal(result.now, 60_000);
      assert.isFalse(result.events.some((event) => event.startsWith("start ")));
    }),
  );

  it.effect("starts immediately without a marker", () =>
    Effect.gen(function* () {
      const result = runLauncher(yield* captureLauncher, {});
      assert.deepInclude(result.output, { remotePort: 5999, serverKind: "managed" });
      assert.equal(result.now, 0);
      assert.equal(result.events.filter((event) => event.startsWith("start ")).length, 1);
      assert.equal(result.events.filter((event) => event.startsWith("marker ")).length, 1);
      assert.equal(result.events.filter((event) => event.startsWith("runtime ")).length, 1);
    }),
  );
});
