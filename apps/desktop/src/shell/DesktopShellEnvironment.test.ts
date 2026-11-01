// @effect-diagnostics nodeBuiltinImport:off -- The process fixture runs real shell commands with isolated config files.
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { SshCommandError } from "@t3tools/ssh/errors";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeOS from "node:os";
import { vi } from "vite-plus/test";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "../ssh/DesktopSshPasswordPrompts.ts";
import * as DesktopShellEnvironment from "./DesktopShellEnvironment.ts";

vi.mock("node:os", { spy: true });

const textEncoder = new TextEncoder();

function envOutput(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .flatMap(([name, value]) => [
      `__T3CODE_ENV_${name}_START__`,
      value,
      `__T3CODE_ENV_${name}_END__`,
    ])
    .join("\n");
}

function makeProcess(output: string, exitCode = 0): ChildProcessSpawner.ChildProcessHandle {
  const stdout = output.length === 0 ? Stream.empty : Stream.make(textEncoder.encode(output));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout,
    stderr: Stream.empty,
    all: stdout,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function withProcessEnv<A, E, R>(
  env: NodeJS.ProcessEnv,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env;
      process.env = env;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        process.env = previous;
      }),
  );
}

function runShellEnvironment(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly userShell?: string;
  readonly handler: (
    command: ChildProcess.Command,
  ) => string | { output: string; exitCode: number };
  readonly failure?: PlatformError.PlatformError;
  readonly exercise?: (
    shell: DesktopShellEnvironment.DesktopShellEnvironment["Service"],
  ) => Effect.Effect<void>;
  readonly processSpawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) {
  const layerEnvironment = Layer.succeed(
    DesktopEnvironment.DesktopEnvironment,
    DesktopEnvironment.DesktopEnvironment.of({
      platform: input.platform,
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
  );
  const layerSpawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      if (input.processSpawner) return input.processSpawner.spawn(command);
      if (input.failure !== undefined) return Effect.fail(input.failure);
      const result = input.handler(command);
      return Effect.succeed(
        typeof result === "string"
          ? makeProcess(result)
          : makeProcess(result.output, result.exitCode),
      );
    }),
  );

  const program = Effect.gen(function* () {
    const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
    const prepared = yield* shellEnvironment.installIntoProcess;
    assert.equal(yield* shellEnvironment.installIntoProcess, prepared);
    if (input.exercise) yield* input.exercise(shellEnvironment);
    return prepared;
  }).pipe(
    Effect.provide(
      DesktopShellEnvironment.layer.pipe(
        Layer.provide(Layer.mergeAll(layerEnvironment, NodeServices.layer, layerSpawner)),
      ),
    ),
  );

  return Effect.acquireUseRelease(
    Effect.sync(() =>
      vi.spyOn(NodeOS, "userInfo").mockReturnValue({
        ...NodeOS.userInfo(),
        shell: input.userShell ?? null,
      }),
    ),
    () => withProcessEnv(input.env, program),
    (spy) => Effect.sync(() => spy.mockRestore()),
  );
}

describe("DesktopShellEnvironment", () => {
  it.effect(
    "captures the login-shell PATH when startup writes more than a pipe buffer to stderr",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner.pipe(
          Effect.provide(NodeServices.layer),
        );
        const executable = yield* HostProcess.ExecutablePath;
        const env: NodeJS.ProcessEnv = { SHELL: "/test-shell", PATH: "/usr/bin" };
        const commands: string[] = [];
        const source = [
          "setTimeout(() => process.exit(99), 3000).unref();",
          "process.stderr.write(Buffer.alloc(2 * 1024 * 1024, 120), () => {",
          `process.stdout.write(${JSON.stringify(envOutput({ PATH: "/shell-only/bin:/usr/bin" }))});`,
          "});",
        ].join("\n");

        yield* runShellEnvironment({
          env,
          platform: "linux",
          handler: () => "",
          processSpawner: ChildProcessSpawner.make((command) => {
            if (command._tag !== "StandardCommand") return Effect.succeed(makeProcess(""));
            commands.push(command.command);
            return command.command === "/test-shell"
              ? spawner.spawn(ChildProcess.make(executable, ["-e", source], command.options))
              : Effect.succeed(makeProcess(""));
          }),
        }).pipe(Effect.provide(Logger.layer([])));

        assert.equal(env.PATH, "/shell-only/bin:/usr/bin");
        assert.deepEqual(commands, ["/test-shell"]);
      }),
  );

  it.effect("rejects PATH output from a failed shell and tries the next candidate", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/failing", PATH: "/usr/bin" };
      const commands: string[] = [];

      yield* runShellEnvironment({
        env,
        platform: "linux",
        userShell: "/usr/local/bin/fish",
        handler: (command) => {
          if (command._tag !== "StandardCommand") return "";
          commands.push(command.command);
          return command.command === "/bin/failing"
            ? { output: envOutput({ PATH: "/failed/bin" }), exitCode: 7 }
            : envOutput({ PATH: "/home/test/.local/bin:/usr/bin" });
        },
      }).pipe(Effect.provide(Logger.layer([])));

      assert.deepEqual(commands, ["/bin/failing", "/usr/local/bin/fish"]);
      assert.equal(env.PATH, "/home/test/.local/bin:/usr/bin");
    }),
  );

  it.effect.each(["fallback shell", "launchctl"] as const)(
    "retries a degraded %s capture after five seconds and retains recovery",
    (fallback) => {
      let ready = false;
      let probes = 0;
      return runShellEnvironment({
        env: { SHELL: "/preferred-shell", PATH: "/usr/bin" },
        platform: "darwin",
        handler: (command) => {
          if (command._tag !== "StandardCommand") return "";
          if (command.command === "/preferred-shell") {
            probes += 1;
            return ready ? envOutput({ PATH: "/recovered/bin" }) : "";
          }
          return fallback === "fallback shell"
            ? envOutput({ PATH: "/fallback/bin" })
            : command.command === "/bin/launchctl"
              ? "/fallback/bin"
              : "";
        },
        exercise: (shell) =>
          Effect.gen(function* () {
            ready = true;
            yield* TestClock.adjust("4999 millis");
            assert.equal(yield* shell.installIntoProcess, false);
            assert.equal(probes, 1);
            yield* TestClock.adjust("1 millis");
            assert.equal(yield* shell.installIntoProcess, true);
            assert.equal(probes, 2);
            yield* TestClock.adjust("1 hour");
            assert.equal(yield* shell.installIntoProcess, true);
            assert.equal(probes, 2);
          }),
      }).pipe(Effect.asVoid, Effect.provide(Logger.layer([])));
    },
  );

  it.effect("hydrates PATH and missing SSH_AUTH_SOCK from the login shell on macOS", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/Users/test/.local/bin:/usr/bin",
      };
      const commands: ChildProcess.Command[] = [];

      const prepared = yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: (command) => {
          commands.push(command);
          return envOutput({
            PATH: "/opt/homebrew/bin:/usr/bin",
            SSH_AUTH_SOCK: "/tmp/secretive.sock",
            HOMEBREW_PREFIX: "/opt/homebrew",
          });
        },
      });

      assert.equal(commands.length, 1);
      assert.equal(commands[0]?._tag === "StandardCommand" ? commands[0].command : "", "/bin/zsh");
      assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin");
      assert.equal(env.SSH_AUTH_SOCK, "/tmp/secretive.sock");
      assert.equal(env.HOMEBREW_PREFIX, "/opt/homebrew");
      assert.isTrue(prepared);
    }),
  );

  it.effect("does not mix login-shell locale categories into an inherited locale", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
      };

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: () =>
          envOutput({
            PATH: "/opt/homebrew/bin:/usr/bin",
            LC_ALL: "de_DE.UTF-8",
          }),
      });

      assert.equal(env.LANG, "en_US.UTF-8");
      assert.equal(env.LC_ALL, undefined);
    }),
  );

  it.effect("falls back to a UTF-8 LC_CTYPE when no locale is available on macOS", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
      };

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: () => envOutput({ PATH: "/opt/homebrew/bin:/usr/bin" }),
      });

      assert.equal(env.LANG, undefined);
      assert.equal(env.LC_ALL, undefined);
      assert.equal(env.LC_CTYPE, "en_US.UTF-8");
    }),
  );

  it.effect("hydrates missing CA trust variables from the login shell", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        SSL_CERT_DIR: "/etc/ssl/certs",
      };

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: () =>
          envOutput({
            PATH: "/opt/zerobrew/bin:/usr/bin",
            SSL_CERT_FILE: "/opt/zerobrew/etc/ca-certificates/cacert.pem",
            SSL_CERT_DIR: "/opt/zerobrew/etc/ca-certificates",
            NODE_EXTRA_CA_CERTS: "/Users/me/corp-root.pem",
          }),
      });

      assert.equal(env.SSL_CERT_FILE, "/opt/zerobrew/etc/ca-certificates/cacert.pem");
      assert.equal(env.SSL_CERT_DIR, "/etc/ssl/certs");
      assert.equal(env.NODE_EXTRA_CA_CERTS, "/Users/me/corp-root.pem");
    }),
  );

  it.effect("keeps mise's PATH record with the login shell PATH", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/bash",
        PATH: "/usr/bin",
      };

      yield* runShellEnvironment({
        env,
        platform: "linux",
        handler: () =>
          envOutput({
            PATH: "/home/me/.local/bin:/mise/installs/claude/latest:/mise/shims",
            __MISE_DIFF: "mise-diff",
          }),
      });

      assert.equal(env.__MISE_DIFF, "mise-diff");
    }),
  );

  it.effect("falls back to launchctl PATH on macOS when shell probing does not return one", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/opt/homebrew/bin/nu",
        PATH: "/usr/bin",
      };
      const commands: string[] = [];

      const prepared = yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: (command) => {
          if (command._tag !== "StandardCommand") return "";
          commands.push(command.command);
          return command.command === "/bin/launchctl" ? "/opt/homebrew/bin:/usr/bin" : "";
        },
      });

      assert.deepEqual(commands, ["/opt/homebrew/bin/nu", "/bin/zsh", "/bin/launchctl"]);
      assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin");
      assert.isFalse(prepared);
    }),
  );

  it.effect("leaves macOS preparation incomplete when no login shell returns a PATH", () =>
    Effect.gen(function* () {
      const prepared = yield* runShellEnvironment({
        env: { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        platform: "darwin",
        handler: () => "",
      });

      assert.isFalse(prepared);
    }),
  );

  it.effect("loads PowerShell profile environment on Windows", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        PATH: "C:\\Windows\\System32",
        APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
        USERPROFILE: "C:\\Users\\testuser",
      };

      const prepared = yield* runShellEnvironment({
        env,
        platform: "win32",
        handler: (command) => {
          if (command._tag !== "StandardCommand") return "";
          const loadProfile = !command.args.includes("-NoProfile");
          return loadProfile
            ? envOutput({
                PATH: "C:\\Profile\\Node;C:\\Windows\\System32",
                FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
                FNM_MULTISHELL_PATH: "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
              })
            : envOutput({ PATH: 'C:\\Custom\\Bin;C:";C:\\Windows\\System32' });
        },
      });

      assert.isTrue(prepared);
      assert.equal(
        env.PATH,
        [
          "C:\\Profile\\Node",
          "C:\\Windows\\System32",
          "C:\\Users\\testuser\\AppData\\Roaming\\npm",
          "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
          "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
          "C:\\Users\\testuser\\AppData\\Local\\pnpm",
          "C:\\Users\\testuser\\.local\\bin",
          "C:\\Users\\testuser\\.bun\\bin",
          "C:\\Users\\testuser\\scoop\\shims",
          "C:\\Custom\\Bin",
          "C:",
        ].join(";"),
      );
      assert.equal(env.FNM_DIR, "C:\\Users\\testuser\\AppData\\Roaming\\fnm");
      assert.equal(
        env.FNM_MULTISHELL_PATH,
        "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
      );
    }),
  );

  it.effect.each([false, true])(
    "leaves Windows preparation incomplete when loadProfile=%s fails",
    (loadProfile) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows\\System32" };
        let calls = 0;
        const prepared = yield* runShellEnvironment({
          env,
          platform: "win32",
          handler: (command) => {
            calls++;
            if (command._tag !== "StandardCommand") return "";
            return !command.args.includes("-NoProfile") === loadProfile
              ? { output: "", exitCode: 1 }
              : envOutput({ PATH: "C:\\Working" });
          },
        }).pipe(Effect.provide(Logger.layer([])));
        assert.isFalse(prepared);
        assert.equal(calls, 3);
        assert.include(env.PATH, "C:\\Working");
        assert.include(env.PATH, "C:\\Windows\\System32");
      }),
  );

  it.effect("replaces a Path-spelled Windows PATH instead of adding a second key", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { Path: "C:\\Windows\\System32" };

      yield* runShellEnvironment({
        env,
        platform: "win32",
        handler: (command) =>
          command._tag === "StandardCommand" && command.args.includes("-NoProfile")
            ? envOutput({ PATH: "C:\\Shell\\Bin" })
            : "",
      });

      assert.deepEqual(env, { PATH: "C:\\Shell\\Bin;C:\\Windows\\System32" });
    }),
  );

  it.effect("prefers login-shell desktop session hints over inherited values on linux", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        XDG_CURRENT_DESKTOP: "wrong-launcher",
        XDG_SESSION_DESKTOP: "wrong-launcher",
      };

      yield* runShellEnvironment({
        env,
        platform: "linux",
        handler: () =>
          envOutput({
            PATH: "/home/linuxbrew/.linuxbrew/bin:/usr/bin",
            XDG_CURRENT_DESKTOP: "KDE",
            XDG_SESSION_DESKTOP: "KDE",
            XDG_SESSION_TYPE: "wayland",
          }),
      });

      assert.equal(env.XDG_CURRENT_DESKTOP, "KDE");
      assert.equal(env.XDG_SESSION_DESKTOP, "KDE");
      assert.equal(env.XDG_SESSION_TYPE, "wayland");
    }),
  );
});

const target = {
  alias: "managed-workspace",
  hostname: "helper-missing.invalid",
  username: null,
  port: null,
};

function runRecoveryScenario(
  operation: "resolve" | "connect" | "disconnect" | "still-unavailable" | "capture-pending",
) {
  return Effect.gen(function* () {
    const paused = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let pauseCapture = false;
    let stops = 0;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-path-" });
    const bin = path.join(home, "bin");
    const helpers = path.join(home, "workspace tools");
    const probes = path.join(home, "probes");
    const ready = path.join(home, "ready");
    const proxyReached = path.join(home, "proxy-reached");
    const config = path.join(home, "ssh_config");
    yield* fs.makeDirectory(bin);
    yield* fs.makeDirectory(helpers);
    const inheritedPath = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
    const shellPath = `${helpers}:${inheritedPath}`;
    const preferredShell = path.join(bin, "preferred-shell");
    yield* fs.writeFileString(
      preferredShell,
      `#!/bin/sh
[ "$1" = "-ilc" ] || exec /bin/sh "$@"
printf 'probe\n' >> '${probes}'
[ -f '${ready}' ] || exit 1
export PATH='${shellPath}'
exec /bin/sh -c "$2"
`,
    );
    yield* fs.chmod(preferredShell, 0o700);
    yield* fs.writeFileString(
      path.join(bin, "ssh"),
      `#!/bin/sh\nexec /usr/bin/ssh -F '${config}' "$@"\n`,
    );
    yield* fs.chmod(path.join(bin, "ssh"), 0o700);
    yield* fs.writeFileString(path.join(helpers, "workspace-check"), "#!/bin/sh\nexit 0\n");
    yield* fs.chmod(path.join(helpers, "workspace-check"), 0o700);
    yield* fs.writeFileString(
      path.join(helpers, "workspace-proxy"),
      `#!/bin/sh\nprintf 'proxy invoked %s\\n' "$1" > '${proxyReached}'\nexit 1\n`,
    );
    yield* fs.chmod(path.join(helpers, "workspace-proxy"), 0o700);
    yield* fs.writeFileString(
      config,
      [
        'Match originalhost managed-workspace exec "workspace-check"',
        "  HostName helper-ready.invalid",
        "Host managed-workspace",
        "  HostName helper-missing.invalid",
        "  ProxyCommand workspace-proxy %h",
        "  ControlMaster no",
        "  ControlPath none",
        "",
      ].join("\n"),
    );

    const layerEnvironment = DesktopEnvironment.layer({
      dirname: home,
      homeDirectory: home,
      platform: "darwin",
      processArch: yield* HostProcess.Architecture,
      appVersion: "0.1.0",
      appPath: home,
      isPackaged: true,
      resourcesPath: home,
      runningUnderArm64Translation: false,
    }).pipe(Layer.provide(DesktopConfig.layerTest({ T3CODE_HOME: home })));
    const layerShell = DesktopShellEnvironment.layer.pipe(Layer.provide(layerEnvironment));
    const layerSsh = DesktopSshEnvironment.layer({
      resolveCliRunner: Effect.succeed({ archiveVersion: "0.1.0" }),
    }).pipe(
      Layer.provideMerge(layerShell),
      Layer.provide(
        Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
          request: () => Effect.die("Unexpected authentication prompt"),
          resolve: () => Effect.die("Unexpected authentication response"),
        }),
      ),
    );
    const program = Effect.gen(function* () {
      const shell = yield* DesktopShellEnvironment.DesktopShellEnvironment;
      const ssh = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      assert.equal(yield* shell.installIntoProcess, false);
      if (operation !== "still-unavailable") yield* fs.writeFileString(ready, "");
      const initialProbes = "probe\n";
      assert.equal(yield* shell.installIntoProcess, false);
      assert.equal((yield* ssh.resolveHost(target.alias)).hostname, "helper-missing.invalid");
      assert.equal(yield* fs.readFileString(probes), initialProbes);
      yield* TestClock.adjust("4999 millis");
      assert.equal((yield* ssh.resolveHost(target.alias)).hostname, "helper-missing.invalid");
      assert.equal(yield* fs.readFileString(probes), initialProbes);
      yield* TestClock.adjust("1 millis");
      if (operation === "capture-pending") {
        pauseCapture = true;
        const preparing = yield* Effect.forkChild(Effect.result(ssh.ensureEnvironment(target)));
        yield* Deferred.await(paused);
        const stopping = yield* Effect.forkChild(Effect.result(ssh.disconnectEnvironment(target)), {
          startImmediately: true,
        });
        yield* TestClock.adjust("0 millis");
        const stopsWhileCapturing = stops;
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(preparing);
        yield* Fiber.join(stopping);
        assert.equal(stopsWhileCapturing, 0);
        assert.equal(stops, 1);
        return;
      }
      if (operation === "resolve") {
        assert.equal((yield* ssh.resolveHost(target.alias)).hostname, "helper-ready.invalid");
        assert.equal((yield* ssh.resolveHost(target.alias)).hostname, "helper-ready.invalid");
      } else {
        if (operation === "disconnect") {
          assert.equal((yield* ssh.resolveHost(target.alias)).hostname, "helper-ready.invalid");
        }
        const result = yield* Effect.result(
          operation === "disconnect"
            ? ssh.disconnectEnvironment(target)
            : ssh.ensureEnvironment(target),
        );
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.instanceOf(result.failure, SshCommandError);
        if (operation === "connect" || operation === "disconnect") {
          assert.equal(
            yield* fs.readFileString(proxyReached),
            operation === "disconnect"
              ? "proxy invoked helper-missing.invalid\n"
              : "proxy invoked helper-ready.invalid\n",
          );
          assert.equal((yield* ssh.resolveHost(target.alias)).hostname, "helper-ready.invalid");
        } else {
          assert.equal(yield* fs.exists(proxyReached), false);
          if (result._tag === "Failure") {
            assert.include(result.failure.message, "workspace-proxy");
          }
          assert.equal((yield* ssh.resolveHost(target.alias)).hostname, "helper-missing.invalid");
        }
      }
      assert.equal(yield* fs.readFileString(probes), "probe\nprobe\n");
      assert.equal(process.env.PATH, operation === "still-unavailable" ? inheritedPath : shellPath);
      yield* TestClock.adjust("1 hour");
      assert.equal(
        (yield* ssh.resolveHost(target.alias)).hostname,
        operation === "still-unavailable" ? "helper-missing.invalid" : "helper-ready.invalid",
      );
      assert.equal(
        yield* fs.readFileString(probes),
        operation === "still-unavailable" ? "probe\nprobe\nprobe\n" : "probe\nprobe\n",
      );
    }).pipe(
      Effect.provide(
        layerSsh.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeHttpClient.layerUndici, NetService.layer)),
        ),
      ),
    );

    const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (ChildProcess.isStandardCommand(command)) {
          if (command.args.some((arg) => arg.startsWith("HostName="))) stops += 1;
          if (command.command === preferredShell && pauseCapture) {
            yield* Deferred.succeed(paused, undefined);
            yield* Deferred.await(resume);
          }
        }
        return yield* nativeSpawner.spawn(
          ChildProcess.isStandardCommand(command) &&
            ["/bin/zsh", "/bin/bash"].includes(command.command)
            ? ChildProcess.make("/bin/sh", ["-c", "exit 1"])
            : command,
        );
      }),
    );
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env;
        process.env = {
          ...previous,
          HOME: home,
          ZDOTDIR: home,
          SHELL: preferredShell,
          PATH: inheritedPath,
        };
        const spy = vi.spyOn(NodeOS, "userInfo").mockReturnValue({
          ...NodeOS.userInfo(),
          shell: preferredShell,
        });
        return { previous, spy };
      }),
      () => program.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      ({ previous, spy }) =>
        Effect.sync(() => {
          spy.mockRestore();
          process.env = previous;
        }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
}

describe.runIf(HostProcess.Platform.defaultValue() !== "win32")(
  "SSH shell PATH recovery with real OpenSSH",
  () => {
    it.effect("waits for a pending shell capture before disconnecting", () =>
      runRecoveryScenario("capture-pending"),
    );
    it.effect(
      "pins remote cleanup to the supplied host after PATH recovery changes alias resolution",
      () => runRecoveryScenario("disconnect"),
    );
    it.effect(
      "recovers a failed startup capture before resolving a host and caches the recovered PATH",
      () => runRecoveryScenario("resolve"),
    );
    it.effect("recovers a failed startup capture before invoking a saved host's ProxyCommand", () =>
      runRecoveryScenario("connect"),
    );
    it.effect("preserves the SSH error when PATH capture is still unavailable", () =>
      runRecoveryScenario("still-unavailable"),
    );
  },
);
