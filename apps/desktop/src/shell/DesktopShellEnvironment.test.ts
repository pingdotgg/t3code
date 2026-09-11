import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopShellEnvironment from "./DesktopShellEnvironment.ts";
import {
  DEFAULT_SHELL_ENVIRONMENT_HARVEST,
  type ShellEnvironmentHarvest,
} from "./shellEnvironmentHarvest.ts";

const textEncoder = new TextEncoder();

const isDesktopShellEnvironmentCommandError = Schema.is(
  DesktopShellEnvironment.DesktopShellEnvironmentCommandError,
);

function envOutput(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .flatMap(([name, value]) => [
      `__T3CODE_ENV_${name}_START__`,
      value,
      `__T3CODE_ENV_${name}_END__`,
    ])
    .join("\n");
}

function fullEnvOutput(values: Readonly<Record<string, string>>, delimiter = "\0"): string {
  const body = Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join(delimiter);
  return ["__T3CODE_ENV_*_START__", body, "__T3CODE_ENV_*_END__"].join("\n");
}

function commandLine(command: ChildProcess.Command): string {
  return command._tag === "StandardCommand" ? command.args.join(" ") : "";
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
  readonly failure?: PlatformError.PlatformError;
  readonly harvest?: ShellEnvironmentHarvest;
}) {
  const environmentLayer = Layer.succeed(
    DesktopEnvironment.DesktopEnvironment,
    DesktopEnvironment.DesktopEnvironment.of({
      platform: input.platform,
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
  );
  const spawnerLayer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      input.failure === undefined
        ? Effect.succeed(makeProcess(input.handler(command)))
        : Effect.fail(input.failure),
    ),
  );

  const program = Effect.gen(function* () {
    const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
    yield* shellEnvironment.installIntoProcess(input.harvest ?? DEFAULT_SHELL_ENVIRONMENT_HARVEST);
  }).pipe(
    Effect.provide(
      DesktopShellEnvironment.layer.pipe(
        Layer.provide(Layer.mergeAll(environmentLayer, NodeServices.layer, spawnerLayer)),
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

  it.effect("hydrates the locale from the login shell on macOS", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
      };

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        handler: () =>
          envOutput({
            PATH: "/opt/homebrew/bin:/usr/bin",
            LANG: "de_DE.UTF-8",
          }),
      });

      assert.equal(env.LANG, "de_DE.UTF-8");
    }),
  );

  it.effect("preserves an inherited locale over the login shell on macOS", () =>
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
            LANG: "de_DE.UTF-8",
          }),
      });

      assert.equal(env.LANG, "en_US.UTF-8");
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

  it.effect("does not apply the locale fallback on linux", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
      };

      yield* runShellEnvironment({
        env,
        platform: "linux",
        handler: () => envOutput({ PATH: "/home/linuxbrew/.linuxbrew/bin:/usr/bin" }),
      });

      assert.equal(env.LANG, undefined);
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
            : envOutput({ PATH: 'C:\\Custom\\Bin;C:";C:\\Windows\\System32' });
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

  it.effect("overrides stale dbus session addresses from the login shell", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/stale-bus",
      };

      yield* runShellEnvironment({
        env,
        platform: "linux",
        handler: () =>
          envOutput({
            PATH: "/usr/bin",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
          }),
      });

      assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
    }),
  );

  it.effect("leaves the probe untouched when no harvest is configured", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
      const commands: ChildProcess.Command[] = [];

      yield* runShellEnvironment({
        env,
        platform: "linux",
        handler: (command) => {
          commands.push(command);
          return envOutput({ PATH: "/usr/bin" });
        },
      });

      const args = commandLine(commands[0] as ChildProcess.Command);
      assert.equal(args.includes("env -0"), false);
      assert.equal(args.includes("printenv OPENAI_API_KEY"), false);
    }),
  );

  it.effect("restores configured extra names from the login shell", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
      const commands: ChildProcess.Command[] = [];

      yield* runShellEnvironment({
        env,
        platform: "linux",
        harvest: { mode: "allowlist", names: ["OPENAI_API_KEY"] },
        handler: (command) => {
          commands.push(command);
          return envOutput({ PATH: "/usr/bin", OPENAI_API_KEY: "sk-test" });
        },
      });

      assert.equal(
        commandLine(commands[0] as ChildProcess.Command).includes("printenv OPENAI_API_KEY"),
        true,
      );
      assert.equal(env.OPENAI_API_KEY, "sk-test");
    }),
  );

  it.effect("lets the login shell win over an inherited value for configured names", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        OPENAI_API_KEY: "sk-stale",
      };

      yield* runShellEnvironment({
        env,
        platform: "linux",
        harvest: { mode: "allowlist", names: ["OPENAI_API_KEY"] },
        handler: () => envOutput({ PATH: "/usr/bin", OPENAI_API_KEY: "sk-fresh" }),
      });

      assert.equal(env.OPENAI_API_KEY, "sk-fresh");
    }),
  );

  it.effect("restores the whole login shell environment in all mode", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
      const commands: ChildProcess.Command[] = [];

      yield* runShellEnvironment({
        env,
        platform: "linux",
        harvest: { mode: "all", names: [] },
        handler: (command) => {
          commands.push(command);
          return [
            envOutput({ PATH: "/usr/bin" }),
            fullEnvOutput({
              PATH: "/usr/bin",
              OPENAI_API_KEY: "sk-test",
              CARGO_HOME: "/home/test/.local/share/cargo",
              GREETING: "line one\nline two",
              CONNECTION: "key=value=more",
            }),
          ].join("\n");
        },
      });

      assert.equal(commandLine(commands[0] as ChildProcess.Command).includes("env -0"), true);
      assert.equal(env.OPENAI_API_KEY, "sk-test");
      assert.equal(env.CARGO_HOME, "/home/test/.local/share/cargo");
      assert.equal(env.GREETING, "line one\nline two");
      assert.equal(env.CONNECTION, "key=value=more");
    }),
  );

  it.effect("does not import process identity names in all mode", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        HOME: "/home/desktop",
        PWD: "/",
      };

      yield* runShellEnvironment({
        env,
        platform: "linux",
        harvest: { mode: "all", names: [] },
        handler: () =>
          [
            envOutput({ PATH: "/usr/bin" }),
            fullEnvOutput({
              HOME: "/home/shell",
              PWD: "/home/shell/projects",
              OLDPWD: "/tmp",
              SHLVL: "3",
              _: "/usr/bin/env",
            }),
          ].join("\n"),
      });

      assert.equal(env.HOME, "/home/desktop");
      assert.equal(env.PWD, "/");
      assert.equal(env.OLDPWD, undefined);
      assert.equal(env.SHLVL, undefined);
      assert.equal(env._, undefined);
    }),
  );

  it.effect("keeps PATH merging and locale precedence in all mode", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
      };

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        harvest: { mode: "all", names: [] },
        handler: () =>
          [
            envOutput({ PATH: "/opt/homebrew/bin" }),
            fullEnvOutput({ PATH: "/only/from/dump", LANG: "de_DE.UTF-8" }),
          ].join("\n"),
      });

      assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin");
      assert.equal(env.LANG, "en_US.UTF-8");
    }),
  );

  it.effect("restores configured extra names from the PowerShell profile on Windows", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows\\System32" };
      const commands: ChildProcess.Command[] = [];

      yield* runShellEnvironment({
        env,
        platform: "win32",
        harvest: { mode: "all", names: ["OPENAI_API_KEY"] },
        handler: (command) => {
          commands.push(command);
          if (command._tag !== "StandardCommand") return "";
          return command.args.includes("-NoProfile")
            ? envOutput({ PATH: "C:\\Windows\\System32" })
            : [
                envOutput({ PATH: "C:\\Windows\\System32", OPENAI_API_KEY: "sk-test" }),
                fullEnvOutput({ CARGO_HOME: "C:\\Users\\test\\.cargo" }, "\n"),
              ].join("\n");
        },
      });

      const profileCommand = commands.find(
        (command) => command._tag === "StandardCommand" && !command.args.includes("-NoProfile"),
      );
      assert.equal(
        commandLine(profileCommand as ChildProcess.Command).includes("Get-ChildItem Env:"),
        true,
      );
      assert.equal(env.OPENAI_API_KEY, "sk-test");
      assert.equal(env.CARGO_HOME, "C:\\Users\\test\\.cargo");
    }),
  );

  it("resolves dbus runtime dir candidates with existence checks", () => {
    const busPath = DesktopShellEnvironment.resolveDefaultLinuxDbusSessionBusAddress({
      env: { XDG_RUNTIME_DIR: "/tmp/stale-runtime" },
      uid: 1000,
      exists: (path) => path === "/run/user/1000/bus",
    });

    assert.equal(busPath, "unix:path=/run/user/1000/bus");
  });

  it.effect("logs command failures with safe probe context and the exact cause", () => {
    const env: NodeJS.ProcessEnv = {
      SHELL: "/bin/bash",
      PATH: "/usr/bin",
    };
    const cause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "ChildProcess",
      method: "spawn",
      pathOrDescriptor: "/bin/bash",
    });
    const messages: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });

    return runShellEnvironment({
      env,
      platform: "linux",
      handler: () => "",
      failure: cause,
    }).pipe(
      Effect.andThen(
        Effect.sync(() => {
          const errors = messages
            .flatMap((message) => (Array.isArray(message) ? message : [message]))
            .filter(isDesktopShellEnvironmentCommandError);
          assert.lengthOf(errors, 1);
          assert.equal(errors[0]?.probe, "login-shell");
          assert.equal(errors[0]?.executable, "bash");
          assert.equal(errors[0]?.argumentCount, 2);
          assert.notProperty(errors[0] ?? {}, "args");
          assert.equal(errors[0]?.cause, cause);
          assert.notInclude(errors[0]?.message ?? "", cause.message);
        }),
      ),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
  });
});
