import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_TERMINAL_ID,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  type TerminalOpenInput,
  ProviderDriverKind,
  ProviderInstanceId,
  ProjectId,
  TerminalProviderInstanceNotFoundError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as TerminalManager from "./Manager.ts";
import { terminalOutputStream } from "./OutputProtocol.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { FakePtyAdapter, GatedPtyAdapter, createManager, encodeUnknownJson, historyLogPath, layerWithHostPlatform, openInput, publishPastOutputBudget } from "./Manager-part2.testkit.ts";

vi.mock("effect/SynchronizedRef", async (importOriginal) => {
  const original = await importOriginal<typeof SynchronizedRef>();
  return { ...original, make: vi.fn(original.make) };
});

// The server omits DOM types, which include TypeScript's WebAssembly declarations.




import { retainedHistory } from "./Manager-fixtures.testkit.ts";
it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    ProcessRunner.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  ),
  { excludeTestServices: true },
)("TerminalManager", (it) => {
  it.effect("retries with fallback shells when preferred shell spawn fails", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const missingShell =
        platform === "win32" ? "C:\\definitely\\missing-shell.exe" : "/definitely/missing-shell -l";
      const { manager, ptyAdapter } = yield* createManager(5, {
        shellResolver: () => missingShell,
      });
      ptyAdapter.spawnFailures.push(new Error("posix_spawnp failed."));

      const snapshot = yield* manager.open(openInput());

      assert.equal(snapshot.status, "running");
      expect(ptyAdapter.spawnInputs.length).toBeGreaterThanOrEqual(2);
      expect(ptyAdapter.spawnInputs[0]?.shell).toBe(
        platform === "win32" ? missingShell : "/definitely/missing-shell",
      );

      if (platform === "win32") {
        expect(
          ptyAdapter.spawnInputs.some(
            (input) =>
              input.shell === "pwsh.exe" ||
              input.shell === "powershell.exe" ||
              input.shell === "cmd.exe",
          ),
        ).toBe(true);
      } else {
        expect(
          ptyAdapter.spawnInputs
            .slice(1)
            .some((input) => input.shell !== "/definitely/missing-shell"),
        ).toBe(true);
      }
    }),
  );
  it.effect(
    "writes completion syntax for the fallback shell instead of the configured fish shell",
    () =>
      Effect.gen(function* () {
        const env = { SHELL: "/missing/fish" };
        const { manager, ptyAdapter, baseDir } = yield* createManager(5, { env }).pipe(
          Effect.provide(layerWithHostPlatform("linux")),
        );
        ptyAdapter.spawnFailures.push(new Error("spawn fish ENOENT"));
        const written = yield* Deferred.make<void>();
        const terminals = TerminalManager.TerminalManager.of({
          ...manager,
          write: (input) =>
            manager.write(input).pipe(Effect.tap(() => Deferred.succeed(written, undefined))),
        });
        const runner = yield* ProjectSetupScriptRunner.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(TerminalManager.TerminalManager, terminals),
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThreadShell: () => Effect.succeed(null),
              }),
              ServerSettings.layerTest(),
              Layer.succeed(HostProcess.Platform, "linux"),
              Layer.succeed(HostProcess.Environment, env),
            ),
          ),
        );
        yield* runner.runForThread({
          threadId: "thread-setup-fallback",
          worktreePath: baseDir,
          project: {
            id: ProjectId.make("project-setup-fallback"),
            workspaceRoot: baseDir,
            scripts: [
              {
                id: "setup",
                name: "Setup",
                command: "echo setup-ready",
                icon: "play",
                runOnWorktreeCreate: true,
              },
            ],
          },
          observeCompletion: {},
        });
        const process = ptyAdapter.processes[0]!;
        process.emitData("\x1b[?2004h");
        yield* Deferred.await(written);
        const command = process.writes[0]!;
        expect(command).toContain('"$?"');
      }),
  );
  it.effect("preserves Windows Path casing when appending managed ACP binaries", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-terminal-acp-path-",
      });
      const installBin = path.join(
        cacheDir,
        "tools",
        "example-agent",
        "1.2.3",
        "windows-x86_64",
        "bin",
      );
      yield* fileSystem.makeDirectory(installBin, { recursive: true });
      yield* fileSystem.makeDirectory(path.join(cacheDir, "acp-registry"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(cacheDir, "acp-registry", "registry.json"),
        encodeUnknownJson({
          version: "1.0.0",
          agents: [
            {
              id: "example-agent",
              name: "Example Agent",
              version: "1.2.3",
              description: "ACP Registry test agent",
              distribution: {
                binary: {
                  "windows-x86_64": {
                    archive: "https://registry.test/example-agent.zip",
                    cmd: "bin/example-agent.exe",
                  },
                },
              },
            },
          ],
        }),
      );
      const { manager, ptyAdapter } = yield* createManager(5, {
        managedBinaryCacheDir: cacheDir,
        managedBinaryToolsDir: path.join(cacheDir, "tools"),
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          Path: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(
        Effect.provide(
          Layer.merge(
            layerWithHostPlatform("win32"),
            Layer.succeed(HostProcess.Architecture, "x64"),
          ),
        ),
      );

      yield* manager.open(openInput());

      const spawnEnv = ptyAdapter.spawnInputs[0]?.env;
      expect(spawnEnv?.PATH).toBeUndefined();
      expect(spawnEnv?.Path).toBe(`C:\\Windows\\System32;${installBin}`);
    }),
  );
  it.effect("falls back to built-in PowerShell by absolute path on Windows", () =>
    Effect.gen(function* () {
      const ptyAdapter = new FakePtyAdapter();
      const { manager } = yield* createManager(5, {
        ptyAdapter,
        shellResolver: () => "C:\\missing\\custom-shell.exe",
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATH: "C:\\Windows\\System32",
          SystemRoot: "C:\\Windows",
        },
      }).pipe(Effect.provide(layerWithHostPlatform("win32")));
      ptyAdapter.spawnFailures.push(
        new Error("spawn custom-shell.exe ENOENT"),
        new Error("spawn pwsh.exe ENOENT"),
      );

      yield* manager.open(openInput());

      expect(ptyAdapter.spawnInputs.map((input) => input.shell)).toEqual([
        "C:\\missing\\custom-shell.exe",
        "pwsh.exe",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ]);
      expect(ptyAdapter.spawnInputs[1]?.args).toEqual(["-NoLogo"]);
      expect(ptyAdapter.spawnInputs[2]?.args).toEqual(["-NoLogo"]);
    }),
  );
  it.effect("closes an idle cmd fallback before rejecting its completion wrapper", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter, baseDir } = yield* createManager(5, {
        env: { SystemRoot: "C:\\Windows" },
        subprocessInspector: () =>
          Effect.succeed({
            hasRunningSubprocess: false,
            childCommand: null,
            processIds: [],
          }),
      }).pipe(Effect.provide(layerWithHostPlatform("win32")));
      ptyAdapter.spawnFailures.push(
        new Error("spawn pwsh ENOENT"),
        new Error("spawn WindowsPowerShell ENOENT"),
        new Error("spawn powershell ENOENT"),
      );
      const runner = yield* ProjectSetupScriptRunner.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(TerminalManager.TerminalManager, manager),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadShell: () => Effect.succeed(null),
            }),
            ServerSettings.layerTest(),
          ),
        ),
      );
      const error = yield* runner
        .runForThread({
          threadId: "thread-cmd-fallback",
          worktreePath: baseDir,
          project: {
            id: ProjectId.make("project-cmd-fallback"),
            workspaceRoot: baseDir,
            scripts: [
              {
                id: "setup",
                name: "Setup",
                command: "echo setup-ready",
                icon: "play",
                runOnWorktreeCreate: true,
              },
            ],
          },
          observeCompletion: {},
        })
        .pipe(Effect.flip);

      expect(error._tag).toBe("ProjectSetupScriptUnsupportedShellError");
      expect(ptyAdapter.spawnInputs.at(-1)?.shell).toBe("C:\\Windows\\System32\\cmd.exe");
      expect(ptyAdapter.processes[0]?.writes).toEqual([]);
      expect(ptyAdapter.processes[0]?.killed).toBe(true);
    }),
  );
  it.effect("turns off fish terminal queries unless the user chose query-term", () =>
    Effect.gen(function* () {
      for (const [platform, env, runtimeEnv, expected] of [
        ["linux", {}, {}, { fish_features: "no-query-term" }],
        [
          "linux",
          { fish_features: "qmark-noglob" },
          {},
          { fish_features: "qmark-noglob,no-query-term" },
        ],
        [
          "linux",
          { fish_features: "qmark-noglob,query-term" },
          {},
          { fish_features: "qmark-noglob,query-term" },
        ],
        [
          "linux",
          { fish_features: "qmark-noglob,no-query-term" },
          {},
          { fish_features: "qmark-noglob,no-query-term" },
        ],
        [
          "linux",
          { fish_features: "query-term" },
          { fish_features: "qmark-noglob" },
          { fish_features: "qmark-noglob,no-query-term" },
        ],
        [
          "win32",
          { FISH_FEATURES: "qmark-noglob" },
          {},
          { FISH_FEATURES: "qmark-noglob,no-query-term" },
        ],
        [
          "win32",
          { Fish_Features: "qmark-noglob,query-term" },
          {},
          { Fish_Features: "qmark-noglob,query-term" },
        ],
        [
          "win32",
          { FISH_FEATURES: "qmark-noglob,no-query-term" },
          {},
          { FISH_FEATURES: "qmark-noglob,no-query-term" },
        ],
        [
          "win32",
          { Fish_Features: "query-term" },
          { fish_features: "qmark-noglob" },
          { Fish_Features: "qmark-noglob,no-query-term" },
        ],
        [
          "win32",
          { FISH_FEATURES: "no-query-term" },
          { fish_features: "qmark-noglob,query-term" },
          { FISH_FEATURES: "qmark-noglob,query-term" },
        ],
      ] as const) {
        const { manager, ptyAdapter } = yield* createManager(5, {
          env,
        }).pipe(Effect.provide(layerWithHostPlatform(platform)));
        yield* manager.open(openInput({ env: runtimeEnv }));
        const fishFeatures = Object.fromEntries(
          Object.entries(ptyAdapter.spawnInputs[0]!.env).filter(
            ([key]) => key.toLowerCase() === "fish_features",
          ),
        );
        expect.soft(fishFeatures, JSON.stringify({ platform, env, runtimeEnv })).toEqual(expected);
      }
    }),
  );
  it.effect("filters app runtime env variables from terminal sessions", () =>
    Effect.gen(function* () {
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          PORT: "5173",
          T3CODE_PORT: "3773",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          TEST_TERMINAL_KEEP: "keep-me",
          TMUX: "/tmp/tmux-1000/default,1234,0",
          TMUX_PANE: "%3",
          ZELLIJ_SESSION_NAME: "work",
          ZELLIJ_CONFIG_DIR: "/home/user/.config/zellij",
        },
      });
      yield* manager.open(openInput());
      yield* manager.open(openInput({ terminalId: "explicit", env: { TMUX_PANE: "%9" } }));
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.PORT).toBeUndefined();
      expect(spawnInput.env.T3CODE_PORT).toBeUndefined();
      expect(spawnInput.env.VITE_DEV_SERVER_URL).toBeUndefined();
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
      expect(spawnInput.env.TMUX).toBeUndefined();
      expect(spawnInput.env.TMUX_PANE).toBeUndefined();
      expect(spawnInput.env.ZELLIJ_SESSION_NAME).toBeUndefined();
      expect(spawnInput.env.ZELLIJ_CONFIG_DIR).toBe("/home/user/.config/zellij");
      expect(ptyAdapter.spawnInputs[1]?.env.TMUX_PANE).toBe("%9");
    }),
  );
  it.effect("strips AppImage runtime env from terminal sessions", () =>
    Effect.gen(function* () {
      const appDir = "/tmp/.mount_T3Codeabc123";
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: {
          APPIMAGE: "/home/user/T3-Code.AppImage",
          APPDIR: appDir,
          ARGV0: "/home/user/T3-Code.AppImage",
          OWD: "/home/user/project",
          PATH: `${appDir}/usr/bin:${appDir}:/usr/local/bin:/usr/bin:/bin`,
          LD_LIBRARY_PATH: `${appDir}/usr/lib:/home/user/.local/lib`,
          XDG_DATA_DIRS: `${appDir}/usr/share:/usr/local/share:/usr/share`,
          GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas`,
          TEST_TERMINAL_KEEP: "keep-me",
        },
      });
      yield* manager.open(openInput());
      const spawnInput = ptyAdapter.spawnInputs[0];
      expect(spawnInput).toBeDefined();
      if (!spawnInput) return;

      expect(spawnInput.env.APPIMAGE).toBeUndefined();
      expect(spawnInput.env.APPDIR).toBeUndefined();
      expect(spawnInput.env.ARGV0).toBeUndefined();
      expect(spawnInput.env.OWD).toBeUndefined();
      expect(spawnInput.env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(spawnInput.env.LD_LIBRARY_PATH).toBe("/home/user/.local/lib");
      expect(spawnInput.env.XDG_DATA_DIRS).toBe("/usr/local/share:/usr/share");
      expect(spawnInput.env.GSETTINGS_SCHEMA_DIR).toBeUndefined();
      expect(spawnInput.env.TEST_TERMINAL_KEEP).toBe("keep-me");
    }),
  );
  it.effect("resolves a provider instance environment before spawning", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      const { manager, ptyAdapter } = yield* createManager(5, {
        env: { T3CODE_SECRET: "server-only" },
        resolveProviderInstanceEnvironment: (requestedId, env) =>
          Effect.succeed({
            ...env,
            PROVIDER_SECRET: requestedId === providerInstanceId ? "secret-value" : "wrong",
            CODEX_HOME: "/accounts/codex-work",
          }),
      });

      const snapshot = yield* manager.open(
        openInput({ providerInstanceId, env: { CLIENT_FLAG: "1" } }),
      );

      expect(ptyAdapter.spawnInputs[0]?.env.PROVIDER_SECRET).toBe("secret-value");
      expect(ptyAdapter.spawnInputs[0]?.env.CODEX_HOME).toBe("/accounts/codex-work");
      expect(ptyAdapter.spawnInputs[0]?.env.CLIENT_FLAG).toBe("1");
      expect(ptyAdapter.spawnInputs[0]?.env.T3CODE_SECRET).toBeUndefined();
      expect(snapshot).not.toHaveProperty("env");
      expect(snapshot).not.toHaveProperty("providerInstanceId");
    }),
  );
  it.effect("fails closed when a provider instance is missing", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("deleted_instance");
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: (requestedId) =>
          Effect.fail(
            new TerminalProviderInstanceNotFoundError({
              providerInstanceId: ProviderInstanceId.make(requestedId),
            }),
          ),
      });

      const error = yield* manager.open(openInput({ providerInstanceId })).pipe(Effect.flip);

      assert.deepStrictEqual(
        error,
        new TerminalProviderInstanceNotFoundError({ providerInstanceId }),
      );
      expect(ptyAdapter.spawnInputs).toHaveLength(0);
    }),
  );
  it.effect.each([
    {
      name: "Codex home",
      driver: "codex",
      variable: "CODEX_HOME",
      config: { homePath: "/configured/codex" },
      expectedHome: "/configured/codex",
    },
    {
      name: "Codex shadow home",
      driver: "codex",
      variable: "CODEX_HOME",
      config: { homePath: "/configured/codex", shadowHomePath: "/configured/codex-shadow" },
      expectedHome: "/configured/codex-shadow",
    },
    {
      name: "Claude home",
      driver: "claudeAgent",
      variable: "CLAUDE_CONFIG_DIR",
      config: { homePath: "/configured/claude" },
      expectedHome: "/configured/claude",
    },
  ])("prefers $name over the instance environment", ({ driver, variable, config, expectedHome }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const environment = yield* TerminalManager.resolveProviderInstanceTerminalEnvironment({
        serverSettings,
        path,
        rawProviderInstanceId: "configured_home",
        env: undefined,
      });

      expect(environment[variable]).toBe(path.resolve(expectedHome));
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({
          providerInstances: {
            [ProviderInstanceId.make("configured_home")]: {
              driver: ProviderDriverKind.make(driver),
              environment: [{ name: variable, value: "~/.environment-account", sensitive: false }],
              config,
            },
          },
        }),
      ),
    ),
  );
  it.effect("restarts a running terminal when the resolved provider environment changes", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      let providerSecret = "first-secret";
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: () =>
          Effect.succeed({ PROVIDER_SECRET: providerSecret }),
      });

      yield* manager.open(openInput({ providerInstanceId }));
      providerSecret = "second-secret";
      yield* manager.open(openInput({ providerInstanceId }));

      expect(ptyAdapter.processes[0]?.killed).toBe(true);
      expect(ptyAdapter.spawnInputs).toHaveLength(2);
      expect(ptyAdapter.spawnInputs[1]?.env.PROVIDER_SECRET).toBe("second-secret");
    }),
  );
  it.effect("attaches to a running provider terminal without resolving the provider again", () =>
    Effect.gen(function* () {
      const providerInstanceId = ProviderInstanceId.make("codex_work");
      let providerAvailable = true;
      const { manager, ptyAdapter } = yield* createManager(5, {
        resolveProviderInstanceEnvironment: (requestedId) =>
          providerAvailable
            ? Effect.succeed({ PROVIDER_SECRET: "secret-value" })
            : Effect.fail(
                new TerminalProviderInstanceNotFoundError({
                  providerInstanceId: ProviderInstanceId.make(requestedId),
                }),
              ),
      });
      yield* manager.open(openInput({ providerInstanceId }));
      providerAvailable = false;
      const events: TerminalAttachStreamEvent[] = [];

      const unsubscribe = yield* manager.attachStream(
        { ...openInput({ providerInstanceId }), restartIfNotRunning: true },
        (event) => Effect.sync(() => events.push(event)),
      );
      unsubscribe();

      expect(events[0]?.type).toBe("snapshot");
      expect(ptyAdapter.spawnInputs).toHaveLength(1);
      expect(ptyAdapter.processes[0]?.killed).toBe(false);
    }),
  );


  // Which client owns the shared PTY size is left open by the issue, so this only asserts
  // that every attached renderer is told the grid the PTY actually has.


  // Client retries resend the first attach's size, which a later resize may have replaced.





  const pathExists = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.exists(filePath));

  const readFileString = (filePath: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.readFileString(filePath));

  const writeFileString = (filePath: string, contents: string) =>
    Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) =>
      fs.writeFileString(filePath, contents),
    );





  // Answers process-table queries after `queryDuration`, honoring the caller's
  // timeout the way ProcessRunner's `timedOutResult` mode does.
  const slowProcessTable = (
    platform: "linux" | "win32",
    queryDuration: Duration.Input,
    queries: Array<{ start: number; end?: number }>,
    started: ReadonlyArray<Deferred.Deferred<void>>,
  ): ProcessRunner.ProcessRunner["Service"] => ({
    run: (input) =>
      Effect.gen(function* () {
        const query: { start: number; end?: number } = { start: yield* Clock.currentTimeMillis };
        queries.push(query);
        const deferred = started[queries.length - 1];
        if (deferred) yield* Deferred.succeed(deferred, undefined);
        const completed = yield* Effect.sleep(queryDuration).pipe(
          Effect.timeoutOption(input.timeout ?? "1 hour"),
        );
        query.end = yield* Clock.currentTimeMillis;
        return {
          stdout: Option.isNone(completed)
            ? ""
            : platform === "win32"
              ? "100|9000|node.exe\n"
              : "  100  9000 node\n",
          stderr: "",
          code: Option.isSome(completed) ? ChildProcessSpawner.ExitCode(0) : null,
          timedOut: Option.isNone(completed),
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });

  const createFallbackManager = (
    platform: "linux" | "win32",
    runner: ProcessRunner.ProcessRunner["Service"],
  ) =>
    createManager(5, { subprocessPollIntervalMs: 1_000, processKillGraceMs: 0 }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provide(layerWithHostPlatform(platform)),
    );










































});
