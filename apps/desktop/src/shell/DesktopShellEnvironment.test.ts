// @effect-diagnostics nodeBuiltinImport:off -- The process fixture runs real shell commands with isolated config files.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeOS from "node:os";
import { vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopShellEnvironment from "./DesktopShellEnvironment.ts";

vi.mock("node:os", { spy: true });

const textEncoder = new TextEncoder();
const cacheCodec = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Number,
    key: Schema.String,
    environment: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  }),
);
const encodeCache = Schema.encodeSync(cacheCodec);
const decodeCache = Schema.decodeUnknownEffect(cacheCodec);

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
  readonly stateDir?: string;
  readonly use?: (
    service: DesktopShellEnvironment.DesktopShellEnvironment["Service"],
  ) => Effect.Effect<boolean, never, import("effect/Scope").Scope>;
  readonly handler: (
    command: ChildProcess.Command,
  ) => string | { output: string; exitCode: number };
  readonly failure?: PlatformError.PlatformError;
  readonly processSpawner?: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) {
  const layerEnvironment = Layer.effect(
    DesktopEnvironment.DesktopEnvironment,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = input.stateDir ?? (yield* fs.makeTempDirectoryScoped());
      return DesktopEnvironment.DesktopEnvironment.of({
        platform: input.platform,
        stateDir,
        homeDirectory: "/test-home",
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
    }),
  ).pipe(Layer.provide(NodeServices.layer));
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
    if (input.use) return yield* input.use(shellEnvironment);
    const prepared = yield* shellEnvironment.awaitDiscovery;
    assert.equal(yield* shellEnvironment.awaitDiscovery, prepared);
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
  it.effect("does not wait for discovery when the cache is missing", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* runShellEnvironment({
        env: { SHELL: "/test-shell", PATH: "/usr/bin" },
        platform: "darwin",
        handler: () => "",
        processSpawner: ChildProcessSpawner.make(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(makeProcess(envOutput({ PATH: "/fresh/bin" }))),
          ),
        ),
        use: (service) =>
          Effect.gen(function* () {
            const startup = yield* service.installIntoProcess.pipe(Effect.forkChild);
            yield* Deferred.await(started);
            assert.isDefined(startup.pollUnsafe());
            yield* Deferred.succeed(release, undefined);
            return yield* service.awaitDiscovery;
          }),
      });
    }),
  );

  it.effect(
    "reuses cached paths immediately and streams fresh discovery without keeping removed paths",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner.pipe(
          Effect.provide(NodeServices.layer),
        );
        const executable = yield* HostProcess.ExecutablePath;
        const first = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
        yield* runShellEnvironment({
          env: first,
          stateDir,
          platform: "darwin",
          handler: () =>
            envOutput({
              PATH: "/old/bin:/usr/bin",
              __MISE_DIFF: "old-mise",
              SSH_AUTH_SOCK: "/old-session.sock",
              JAVA_HOME: "/old/java",
              SSL_CERT_FILE: "/old/cert.pem",
            }),
        });
        const cachePath = `${stateDir}/shell-environment-cache.json`;
        const cached = yield* fs.readFileString(cachePath).pipe(Effect.flatMap(decodeCache));
        assert.equal(cached.environment.PATH, "/old/bin:/usr/bin");
        assert.notProperty(cached.environment, "SSH_AUTH_SOCK");
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const env: NodeJS.ProcessEnv = {
          SHELL: "/bin/zsh",
          PATH: "/launcher/bin",
          SSH_AUTH_SOCK: "/current-session.sock",
        };
        const source = [
          "const values = { PATH: '/fresh/bin:' + process.env.PATH, __MISE_DIFF: 'fresh-mise', JAVA_HOME: process.env.JAVA_HOME, SSL_CERT_FILE: process.env.SSL_CERT_FILE };",
          "for (const [name, value] of Object.entries(values)) {",
          "  if (value !== undefined) process.stdout.write('__T3CODE_ENV_' + name + '_START__\\n' + value + '\\n__T3CODE_ENV_' + name + '_END__\\n');",
          "}",
        ].join("\n");
        let calls = 0;
        yield* runShellEnvironment({
          env,
          stateDir,
          platform: "darwin",
          handler: () => "",
          processSpawner: ChildProcessSpawner.make((command) => {
            calls++;
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(
                command._tag === "StandardCommand"
                  ? spawner.spawn(ChildProcess.make(executable, ["-e", source], command.options))
                  : Effect.succeed(makeProcess("")),
              ),
            );
          }),
          use: (service) =>
            Effect.gen(function* () {
              yield* service.installIntoProcess;
              yield* service.installIntoProcess;
              assert.equal(env.PATH, "/old/bin:/usr/bin:/launcher/bin");
              assert.equal(env.SSH_AUTH_SOCK, "/current-session.sock");
              const replay = yield* Stream.runHead(service.updates);
              assert.isTrue(Option.isSome(replay));
              if (Option.isSome(replay))
                assert.equal(replay.value.environment.__MISE_DIFF, "old-mise");
              yield* Deferred.await(started);
              assert.equal(calls, 1);
              yield* Deferred.succeed(release, undefined);
              yield* service.awaitDiscovery;
              assert.equal(env.PATH, "/fresh/bin:/launcher/bin");
              assert.equal(env.__MISE_DIFF, "fresh-mise");
              assert.isUndefined(env.JAVA_HOME);
              assert.isUndefined(env.SSL_CERT_FILE);
              const fresh = yield* Stream.runHead(service.updates);
              assert.isTrue(Option.isSome(fresh));
              if (Option.isSome(fresh)) {
                assert.equal(fresh.value.environment.PATH, env.PATH);
                assert.isTrue(fresh.value.discovered);
              }
              return true;
            }),
        });
        const refreshed = yield* fs.readFileString(cachePath).pipe(Effect.flatMap(decodeCache));
        assert.equal(refreshed.environment.PATH, "/fresh/bin:/launcher/bin");
        assert.notProperty(refreshed.environment, "JAVA_HOME");
        assert.notProperty(refreshed.environment, "SSL_CERT_FILE");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    "not json",
    '{"version":2,"key":"old","environment":{"PATH":"/bad/bin"}}',
    '{"version":1,"key":"other-shell","environment":{"PATH":"/bad/bin"}}',
  ])("ignores an unusable cache and still starts before discovery: %s", (contents) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${stateDir}/shell-environment-cache.json`, contents);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
      yield* runShellEnvironment({
        env,
        stateDir,
        platform: "darwin",
        handler: () => "",
        processSpawner: ChildProcessSpawner.make(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(makeProcess(envOutput({ PATH: "/fresh/bin" }))),
          ),
        ),
        use: (service) =>
          Effect.gen(function* () {
            const startup = yield* service.installIntoProcess.pipe(Effect.forkChild);
            yield* Deferred.await(started);
            assert.isDefined(startup.pollUnsafe());
            assert.equal(env.PATH, "/usr/bin");
            yield* Deferred.succeed(release, undefined);
            return yield* service.awaitDiscovery;
          }),
      });
      assert.equal(env.PATH, "/fresh/bin:/usr/bin");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "retains the last successful cache on refresh failure and ignores session values in the cache",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped();
        const contents = encodeCache({
          version: 1,
          key: '["darwin","/test-home","/bin/zsh",""]',
          environment: {
            PATH: "/cached/bin",
            __MISE_DIFF: "cached-mise",
            JAVA_HOME: "/cached/java",
            NODE_EXTRA_CA_CERTS: "/cached/ca.pem",
            SSL_CERT_FILE: "/cached/cert.pem",
            SSL_CERT_DIR: "/cached/certs",
            SSH_AUTH_SOCK: "/stale.sock",
            NODE_OPTIONS: "--bad",
          },
        });
        const cachePath = `${stateDir}/shell-environment-cache.json`;
        yield* fs.writeFileString(cachePath, contents);
        const env: NodeJS.ProcessEnv = {
          SHELL: "/bin/zsh",
          PATH: "/usr/bin",
          __MISE_DIFF: "launcher-mise",
          JAVA_HOME: "/launcher/java",
          NODE_EXTRA_CA_CERTS: "/launcher/ca.pem",
          SSL_CERT_FILE: "",
          SSH_AUTH_SOCK: "/current.sock",
        };
        const prepared = yield* runShellEnvironment({
          env,
          stateDir,
          platform: "darwin",
          handler: () => "",
          use: (service) =>
            Effect.gen(function* () {
              yield* service.installIntoProcess;
              const replay = yield* Stream.runHead(service.updates);
              assert.isTrue(Option.isSome(replay));
              if (Option.isSome(replay)) {
                assert.equal(replay.value.environment.JAVA_HOME, "/launcher/java");
                assert.equal(replay.value.environment.NODE_EXTRA_CA_CERTS, "/launcher/ca.pem");
              }
              return yield* service.awaitDiscovery;
            }),
        });
        assert.isFalse(prepared);
        assert.equal(env.PATH, "/cached/bin:/usr/bin");
        assert.equal(env.__MISE_DIFF, "cached-mise");
        assert.equal(env.JAVA_HOME, "/launcher/java");
        assert.equal(env.NODE_EXTRA_CA_CERTS, "/launcher/ca.pem");
        assert.equal(env.SSL_CERT_FILE, "");
        assert.equal(env.SSL_CERT_DIR, "/cached/certs");
        assert.equal(env.SSH_AUTH_SOCK, "/current.sock");
        assert.isUndefined(env.NODE_OPTIONS);
        assert.equal(yield* fs.readFileString(cachePath), contents);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("cancels background discovery when the application scope closes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      yield* runShellEnvironment({
        env: { SHELL: "/bin/zsh", PATH: "/usr/bin" },
        platform: "darwin",
        handler: () => "",
        processSpawner: ChildProcessSpawner.make(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
        ),
        use: (service) =>
          Effect.gen(function* () {
            yield* service.installIntoProcess;
            yield* Deferred.await(started);
            return true;
          }),
      });
      yield* Deferred.await(stopped);
    }),
  );

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
