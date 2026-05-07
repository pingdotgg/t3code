import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";

import * as DesktopShellEnvironment from "./DesktopShellEnvironment.ts";

const LOGIN_SHELL_ENV_NAMES = [
  "PATH",
  "SSH_AUTH_SOCK",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

type ProbeOverrides = NonNullable<Parameters<typeof DesktopShellEnvironment.layerTest>[0]["probe"]>;

function runShellEnvironment(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly userShell?: string;
  readonly probe: ProbeOverrides;
  readonly logger?: Logger.Logger<unknown, void>;
}) {
  const shellEnvironmentLayer = DesktopShellEnvironment.layerTest({
    env: input.env,
    platform: input.platform,
    ...(input.userShell === undefined ? {} : { userShell: input.userShell }),
    probe: input.probe,
  });
  const layer =
    input.logger === undefined
      ? shellEnvironmentLayer
      : Layer.mergeAll(
          shellEnvironmentLayer,
          Logger.layer([input.logger], { mergeWithExisting: false }),
        );

  return Effect.gen(function* () {
    const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
    yield* shellEnvironment.installIntoProcess;
  }).pipe(Effect.provide(layer));
}

describe("DesktopShellEnvironment", () => {
  it.effect("hydrates PATH and missing SSH_AUTH_SOCK from the login shell on macOS", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "/bin/zsh",
        PATH: "/Users/test/.local/bin:/usr/bin",
      };
      const calls: Array<{ readonly shell: string; readonly names: ReadonlyArray<string> }> = [];

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        probe: {
          readLoginShellEnvironment: (shell, names) =>
            Effect.sync(() => {
              calls.push({ shell, names });
              return {
                PATH: "/opt/homebrew/bin:/usr/bin",
                SSH_AUTH_SOCK: "/tmp/secretive.sock",
                HOMEBREW_PREFIX: "/opt/homebrew",
              };
            }),
        },
      });

      assert.deepEqual(calls, [{ shell: "/bin/zsh", names: LOGIN_SHELL_ENV_NAMES }]);
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
        probe: {
          readLoginShellEnvironment: () =>
            Effect.succeed({
              PATH: "/opt/homebrew/bin:/usr/bin",
              SSH_AUTH_SOCK: "/tmp/login-shell.sock",
            }),
        },
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
      const calls: Array<{ readonly shell: string; readonly names: ReadonlyArray<string> }> = [];

      yield* runShellEnvironment({
        env,
        platform: "linux",
        probe: {
          readLoginShellEnvironment: (shell, names) =>
            Effect.sync(() => {
              calls.push({ shell, names });
              return {
                PATH: "/home/linuxbrew/.linuxbrew/bin:/usr/bin",
                SSH_AUTH_SOCK: "/tmp/secretive.sock",
              };
            }),
        },
      });

      assert.deepEqual(calls, [{ shell: "/bin/zsh", names: LOGIN_SHELL_ENV_NAMES }]);
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
      const calls: Array<{ readonly shell: string; readonly names: ReadonlyArray<string> }> = [];
      const messages: string[] = [];
      const logger = Logger.make(({ message }) => {
        messages.push(String(message));
      });

      yield* runShellEnvironment({
        env,
        platform: "darwin",
        userShell: "/bin/zsh",
        logger,
        probe: {
          readLoginShellEnvironment: (shell, names) =>
            Effect.gen(function* () {
              calls.push({ shell, names });
              if (calls.length === 1) {
                return yield* Effect.fail(new Error("unknown flag"));
              }
              return {};
            }),
          readLaunchctlPath: Effect.succeed(Option.some("/opt/homebrew/bin:/usr/bin")),
        },
      });

      assert.deepEqual(calls, [
        { shell: "/opt/homebrew/bin/nu", names: LOGIN_SHELL_ENV_NAMES },
        { shell: "/bin/zsh", names: LOGIN_SHELL_ENV_NAMES },
      ]);
      assert.isTrue(
        messages.some((message) => message.includes("failed to read login shell environment")),
      );
      assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin");
    }),
  );

  it.effect("does nothing on unsupported platforms", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        SHELL: "C:/Program Files/Git/bin/bash.exe",
        PATH: "C:\\Windows\\System32",
        SSH_AUTH_SOCK: "/tmp/inherited.sock",
      };
      let readCount = 0;

      yield* runShellEnvironment({
        env,
        platform: "freebsd",
        probe: {
          readLoginShellEnvironment: () =>
            Effect.sync(() => {
              readCount += 1;
              return {
                PATH: "/usr/local/bin:/usr/bin",
                SSH_AUTH_SOCK: "/tmp/secretive.sock",
              };
            }),
        },
      });

      assert.equal(readCount, 0);
      assert.equal(env.PATH, "C:\\Windows\\System32");
      assert.equal(env.SSH_AUTH_SOCK, "/tmp/inherited.sock");
    }),
  );

  it.effect("hydrates PATH on Windows from PowerShell and common CLI directories", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        PATH: "C:\\Windows\\System32",
        APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\testuser\\AppData\\Local",
        USERPROFILE: "C:\\Users\\testuser",
      };
      const windowsReads: Array<{
        readonly names: ReadonlyArray<string>;
        readonly loadProfile: boolean;
      }> = [];

      yield* runShellEnvironment({
        env,
        platform: "win32",
        probe: {
          readWindowsEnvironment: (names, options) =>
            Effect.sync(() => {
              windowsReads.push({ names, loadProfile: options.loadProfile });
              return options.loadProfile ? {} : { PATH: "C:\\Custom\\Bin;C:\\Windows\\System32" };
            }),
        },
      });

      assert.deepEqual(windowsReads, [
        { names: ["PATH"], loadProfile: false },
        { names: ["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"], loadProfile: true },
      ]);
      assert.equal(
        env.PATH,
        [
          "C:\\Users\\testuser\\AppData\\Roaming\\npm",
          "C:\\Users\\testuser\\AppData\\Local\\Programs\\nodejs",
          "C:\\Users\\testuser\\AppData\\Local\\Volta\\bin",
          "C:\\Users\\testuser\\AppData\\Local\\pnpm",
          "C:\\Users\\testuser\\.bun\\bin",
          "C:\\Users\\testuser\\scoop\\shims",
          "C:\\Custom\\Bin",
          "C:\\Windows\\System32",
        ].join(";"),
      );
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
        probe: {
          readWindowsEnvironment: (_names, options) =>
            Effect.succeed(
              options.loadProfile
                ? {
                    PATH: "C:\\Profile\\Node;C:\\Windows\\System32",
                    FNM_DIR: "C:\\Users\\testuser\\AppData\\Roaming\\fnm",
                    FNM_MULTISHELL_PATH:
                      "C:\\Users\\testuser\\AppData\\Local\\fnm_multishells\\123",
                  }
                : { PATH: "C:\\Custom\\Bin;C:\\Windows\\System32" },
            ),
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

  it.effect("preserves baseline Windows env when the profile probe fails", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = {
        PATH: "C:\\Windows\\System32",
        APPDATA: "C:\\Users\\testuser\\AppData\\Roaming",
        USERPROFILE: "C:\\Users\\testuser",
      };

      yield* runShellEnvironment({
        env,
        platform: "win32",
        probe: {
          readWindowsEnvironment: (_names, options) =>
            options.loadProfile
              ? Effect.fail(new Error("profile load failed"))
              : Effect.succeed({ PATH: "C:\\Custom\\Bin;C:\\Windows\\System32" }),
        },
      });

      assert.equal(
        env.PATH,
        [
          "C:\\Users\\testuser\\AppData\\Roaming\\npm",
          "C:\\Users\\testuser\\.bun\\bin",
          "C:\\Users\\testuser\\scoop\\shims",
          "C:\\Custom\\Bin",
          "C:\\Windows\\System32",
        ].join(";"),
      );
      assert.isUndefined(env.SSH_AUTH_SOCK);
    }),
  );
});
