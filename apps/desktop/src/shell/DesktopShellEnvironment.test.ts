import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopShellEnvironment from "./DesktopShellEnvironment.ts";

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

function makeProcess(output: string): ChildProcessSpawner.ChildProcessHandle {
  const stdout = output.length === 0 ? Stream.empty : Stream.make(textEncoder.encode(output));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout,
    stderr: Stream.empty,
    all: stdout,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
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
  readonly handler: (command: ChildProcess.Command) => string;
}) {
  const environmentLayer = Layer.succeed(
    DesktopEnvironment.DesktopEnvironment,
    DesktopEnvironment.DesktopEnvironment.of({
      platform: input.platform,
    } as DesktopEnvironment.DesktopEnvironmentShape),
  );
  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => Effect.succeed(makeProcess(input.handler(command)))),
  );

  const program = Effect.gen(function* () {
    const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
    yield* shellEnvironment.installIntoProcess;
  }).pipe(
    Effect.provide(
      DesktopShellEnvironment.layer.pipe(
        Layer.provide(Layer.mergeAll(environmentLayer, spawnerLayer)),
      ),
    ),
  );

  return withProcessEnv(input.env, program);
}

describe("DesktopShellEnvironment", () => {
  it.effect("hydrates PATH and missing SSH_AUTH_SOCK from the login shell on macOS", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/Users/test/.local/bin:/usr/bin",
      };
      const commands: ChildProcess.Command[] = [];

      yield* runShellEnvironment({
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
    }),
  );

  it.effect("preserves inherited POSIX values when present", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        SSH_AUTH_SOCK: "/tmp/inherited.sock",
      };

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: () =>
          envOutput({
            PATH: "/opt/homebrew/bin:/usr/bin",
            SSH_AUTH_SOCK: "/tmp/login-shell.sock",
          }),
      });

      assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin");
      assert.equal(env.SSH_AUTH_SOCK, "/tmp/inherited.sock");
    }),
  );

  it.effect("hydrates PATH and missing SSH_AUTH_SOCK from the login shell on linux", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
      };

      yield* runShellEnvironment({
        env,
        platform: "linux",
        handler: () =>
          envOutput({
            PATH: "/home/linuxbrew/.linuxbrew/bin:/usr/bin",
            SSH_AUTH_SOCK: "/tmp/secretive.sock",
          }),
      });

      assert.equal(env.PATH, "/home/linuxbrew/.linuxbrew/bin:/usr/bin");
      assert.equal(env.SSH_AUTH_SOCK, "/tmp/secretive.sock");
    }),
  );

  it.effect("falls back to launchctl PATH on macOS when shell probing does not return one", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/opt/homebrew/bin/nu",
        PATH: "/usr/bin",
      };
      const commands: string[] = [];

      yield* runShellEnvironment({
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

      yield* runShellEnvironment({
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
            : envOutput({ PATH: "C:\\Custom\\Bin;C:\\Windows\\System32" });
        },
      });

      assert.equal(
        env.PATH,
        [
          "C:\\Profile\\Node",
          "C:\\Windows\\System32",
          "C:\\Users\\testuser\\AppData\\Roaming\\npm",
          "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
          "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
          "C:\\Users\\testuser\\AppData\\Local\\pnpm",
          "C:\\Users\\testuser\\.bun\\bin",
          "C:\\Users\\testuser\\scoop\\shims",
          "C:\\Custom\\Bin",
        ].join(";"),
      );
      assert.equal(env.FNM_DIR, "C:\\Users\\testuser\\AppData\\Roaming\\fnm");
      assert.equal(
        env.FNM_MULTISHELL_PATH,
        "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
      );
    }),
  );
});
