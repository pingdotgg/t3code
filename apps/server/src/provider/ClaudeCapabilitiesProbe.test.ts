// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, type ServerProvider } from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  makeClaudeWorkspaceCommands,
  probeClaudeCapabilities,
  probeClaudeWorkspaceSnapshot,
} from "./ClaudeProvider.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });
vi.mock("node:os", { spy: true });

const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

it("drops strict MCP mode, and only that, next to an administrator's managed-mcp.json", () => {
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController: new AbortController(),
    environment: { HOME: "/home/user" },
    cwd: undefined,
    managedMcpConfig: true,
  });

  // Claude exits before initializing when handed --strict-mcp-config here.
  assert.equal(options.strictMcpConfig, undefined);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

it.effect("reports a deleted worktree's scan as finished, not pending", () =>
  Effect.gen(function* () {
    const snapshot = yield* probeClaudeWorkspaceSnapshot(
      yield* decodeClaudeSettings({}),
      { skills: [], slashCommands: [] } as unknown as ServerProvider,
      "/nonexistent/t3-deleted-worktree",
      { HOME: "/nonexistent/t3-home" },
      () => Effect.die("a deleted worktree must not start the CLI"),
    );
    assert.strictEqual(snapshot.slashCommandsPending, false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const makeCommandSourcesFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
  const write = Effect.fnUntraced(function* (file: string, contents = "contents") {
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(file, contents);
  });
  // A linked worktree, as `git worktree add` lays it out, with the cwd below its root.
  const main = path.join(root, "main");
  const worktree = path.join(root, "worktree");
  const gitDirectory = path.join(main, ".git", "worktrees", "worktree");
  const cwd = path.join(worktree, "packages", "app");
  yield* write(path.join(worktree, ".git"), `gitdir: ${gitDirectory}\n`);
  yield* write(path.join(gitDirectory, "commondir"), "../..\n");
  yield* write(path.join(gitDirectory, "gitdir"), `${path.join(worktree, ".git")}\n`);
  yield* fileSystem.makeDirectory(cwd, { recursive: true });

  let probes = 0;
  let failing = false;
  const config = path.join(root, "config");
  const makeCommands = (environment: NodeJS.ProcessEnv = {}, homePath = config) =>
    makeClaudeWorkspaceCommands({ homePath }, environment, () =>
      Effect.suspend(() => {
        probes += 1;
        return failing ? Effect.fail("probe failed") : Effect.succeed([{ name: "review" }]);
      }),
    );
  return {
    path,
    write,
    root,
    main,
    worktree,
    cwd,
    config,
    makeCommands,
    probes: () => probes,
    failNextProbes: (value: boolean) => {
      failing = value;
    },
  };
});

const machine = { version: "1.0.0", auth: { status: "authenticated" }, slashCommands: [] } as const;

it.effect("starts the CLI again only when a source of its command list changes", () =>
  Effect.gen(function* () {
    using _release = vi.spyOn(NodeOS, "release").mockReturnValue("6.8.0");
    const { path, write, main, worktree, cwd, config, makeCommands, probes } =
      yield* makeCommandSourcesFixture;
    const commands = yield* makeCommands();

    yield* commands.get(machine, cwd);
    yield* commands.get(machine, cwd);
    assert.strictEqual(probes(), 1);

    // Each of these changed real CLI output or feeds it; see fingerprintClaudeCommandSources.
    for (const source of [
      path.join(config, "commands", "nested", "a.md"),
      path.join(config, "skills", "a", "SKILL.md"),
      path.join(config, "workflows", "a.js"),
      path.join(config, "synced", "account", "a", "SKILL.md"),
      path.join(config, "settings.json"),
      path.join(config, "plugins", "installed_plugins.json"),
      path.join(config, "plugins", "synced", "account", ".marketplace-a.json"),
      path.join(config, "plugins", "cache", "market", "plugin", "1.0.0", "commands", "a.md"),
      path.join(config, "plugins", "cache", "market", "plugin", "1.0.0", "skills", "store", "a.md"),
      path.join(cwd, ".claude", "commands", "a.md"),
      path.join(cwd, ".claude", "skills", "a", "SKILL.md"),
      path.join(cwd, ".claude", "workflows", "a.js"),
      path.join(cwd, ".claude", "settings.json"),
      path.join(cwd, ".claude", "settings.local.json"),
      path.join(worktree, ".claude", "commands", "a.md"),
      path.join(main, ".claude", "skills", "a", "SKILL.md"),
    ]) {
      const before = probes();
      yield* write(
        source,
        source.endsWith("installed_plugins.json") ? '{"plugins":{}}' : "contents",
      );
      yield* commands.get(machine, cwd);
      assert.strictEqual(probes(), before + 1, `${source} should start the CLI`);
      yield* commands.get(machine, cwd);
      assert.strictEqual(probes(), before + 1, `${source} should settle`);
    }

    const edited = path.join(cwd, ".claude", "commands", "a.md");
    const beforeEdit = probes();
    yield* write(edited, "edited description");
    yield* commands.get(machine, cwd);
    assert.strictEqual(probes(), beforeEdit + 1);

    const beforeUnrelated = probes();
    yield* write(path.join(cwd, ".claude", "agents", "a.md"));
    yield* write(path.join(config, "plugins", "marketplaces", "market", "README.md"));
    yield* write(path.join(config, "plugins", "store", "runtime-state.json"));
    yield* write(path.join(config, "plugins", "synced", "account", ".last-complete-round"));
    yield* write(path.join(config, "plugins", "synced", "account", ".marketplaces.json"));
    yield* commands.get(machine, cwd);
    assert.strictEqual(probes(), beforeUnrelated);
  }).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("starts the CLI again when the health check's view of it changes", () =>
  Effect.gen(function* () {
    using _release = vi.spyOn(NodeOS, "release").mockReturnValue("6.8.0");
    const { cwd, makeCommands, probes } = yield* makeCommandSourcesFixture;
    const commands = yield* makeCommands();
    yield* commands.get(machine, cwd);
    yield* commands.get({ ...machine, version: "1.0.1" }, cwd);
    assert.strictEqual(probes(), 2);
    yield* commands.get({ ...machine, auth: { status: "unauthenticated" } }, cwd);
    assert.strictEqual(probes(), 3);
    yield* commands.get({ ...machine, slashCommands: [{ name: "upgrade" }] }, cwd);
    assert.strictEqual(probes(), 4);
  }).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("keeps folders apart, retries failures, and forgets on invalidate", () =>
  Effect.gen(function* () {
    using _release = vi.spyOn(NodeOS, "release").mockReturnValue("6.8.0");
    const { cwd, worktree, makeCommands, probes, failNextProbes } =
      yield* makeCommandSourcesFixture;
    const commands = yield* makeCommands();

    failNextProbes(true);
    yield* commands.get(machine, cwd).pipe(Effect.result);
    failNextProbes(false);
    yield* commands.get(machine, cwd);
    assert.strictEqual(probes(), 2);

    yield* commands.get(machine, worktree);
    assert.strictEqual(probes(), 3);

    yield* commands.invalidate;
    yield* commands.get(machine, cwd);
    assert.strictEqual(probes(), 4);
  }).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("always starts the CLI when its sources cannot be vouched for", () =>
  Effect.gen(function* () {
    using _release = vi.spyOn(NodeOS, "release").mockReturnValue("6.8.0");
    const { path, write, root, cwd, config, makeCommands, probes } =
      yield* makeCommandSourcesFixture;
    const probesTwice = (commands: Effect.Success<ReturnType<typeof makeCommands>>) =>
      Effect.gen(function* () {
        const before = probes();
        yield* commands.get(machine, cwd);
        yield* commands.get(machine, cwd);
        assert.strictEqual(probes(), before + 2);
      });

    const childHome = path.join(root, "child-home");
    const homeCommands = yield* makeCommands({ HOME: childHome }, "");
    yield* probesTwice(homeCommands);
    yield* write(path.join(childHome, ".claude", "commands", "home.md"), "updated command");
    yield* probesTwice(homeCommands);

    yield* probesTwice(yield* makeCommands({ CLAUDE_CODE_PLUGIN_DIRS: "/elsewhere" }));
    for (const environment of [
      { CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE: "1" },
      { CLAUDE_CODE_REMOTE_SETTINGS_PATH: "/elsewhere" },
      { GIT_DIR: "/elsewhere" },
      { GIT_COMMON_DIR: "/elsewhere" },
      { GIT_WORK_TREE: "/elsewhere" },
      { GIT_CEILING_DIRECTORIES: "/elsewhere" },
    ]) {
      yield* probesTwice(yield* makeCommands(environment));
    }
    yield* probesTwice(yield* makeCommands()).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
    );
    yield* probesTwice(yield* makeCommands({ WSL_INTEROP: "/run/WSL/1_interop" })).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
    );

    const fileSystem = yield* FileSystem.FileSystem;
    const commands = yield* makeCommands();
    const settings = path.join(cwd, ".claude", "settings.json");
    yield* write(settings, '{"env":{"CLAUDE_CODE_PLUGIN_SEED_DIR":"/elsewhere"}}');
    yield* probesTwice(commands);
    yield* write(settings, "{}");

    yield* write(settings, '{"env":{"\\u0043LAUDE_CODE_PLUGIN_CACHE_DIR":"/elsewhere"}}');
    yield* probesTwice(commands);
    yield* write(settings, "{}");

    for (const plist of [
      `/Library/Managed Preferences/${NodeOS.userInfo().username}/com.anthropic.claudecode.plist`,
      "/Library/Managed Preferences/com.anthropic.claudecode.plist",
    ]) {
      const fixturePlist = path.join(root, "managed.plist");
      yield* write(fixturePlist);
      yield* probesTwice(commands).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          stat: (entry) => fileSystem.stat(entry === plist ? fixturePlist : entry),
        }),
      );
    }

    for (const contents of [
      '{"env":{"CLAUDE_CONFIG_DIR":"/elsewhere"}}',
      '{"env":{"HOME":"/elsewhere"}}',
      '{"env":{"USERPROFILE":"/elsewhere"}}',
      '{"permissions":{"additionalDirectories":["/elsewhere"]}}',
      '{"policyHelpers":{"macos":{"command":"helper"}}}',
    ]) {
      yield* write(settings, contents);
      yield* probesTwice(commands);
    }
    yield* write(settings, "{}");

    const remoteSettings = path.join(config, "remote-settings.json");
    yield* write(remoteSettings, '{"env":{"CLAUDE_CODE_PLUGIN_CACHE_DIR":"/elsewhere"}}');
    yield* probesTwice(commands);
    yield* write(remoteSettings, "{}");
    yield* probesTwice(commands);
    yield* fileSystem.remove(remoteSettings);

    const redirectedPlugins = path.join(root, "redirected-plugins");
    const redirectedCommand = path.join(
      redirectedPlugins,
      "cache",
      "a",
      "1.0.0",
      "commands",
      "review.md",
    );
    for (const settingsPath of [path.join(config, "settings.json"), settings]) {
      yield* write(
        settingsPath,
        JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_CACHE_DIR: redirectedPlugins } }),
      );
      yield* write(redirectedCommand, "before edit");
      yield* probesTwice(commands);
      const beforeRedirectedEdit = probes();
      yield* write(redirectedCommand, "after redirected command edit");
      yield* commands.get(machine, cwd);
      assert.strictEqual(probes(), beforeRedirectedEdit + 1);
      yield* write(settingsPath, "{}");
    }

    const managedPath = (entry: string) =>
      entry.replace(/^[/\\]etc[/\\]claude-code(?=[/\\]|$)/, path.join(root, "ClaudeCode"));
    yield* Effect.gen(function* () {
      const managedCommands = yield* makeCommands();
      const dropIn = path.join(root, "ClaudeCode", "managed-settings.d", "plugins.json");
      yield* write(dropIn, "{}");
      const beforeManaged = probes();
      yield* managedCommands.get(machine, cwd);
      yield* managedCommands.get(machine, cwd);
      assert.strictEqual(probes(), beforeManaged + 1);

      yield* write(
        dropIn,
        JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_CACHE_DIR: redirectedPlugins } }),
      );
      yield* probesTwice(managedCommands);
      const beforeManagedEdit = probes();
      yield* write(redirectedCommand, "edited command under managed redirect");
      yield* managedCommands.get(machine, cwd);
      assert.strictEqual(probes(), beforeManagedEdit + 1);
      yield* write(dropIn, "{}");
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(FileSystem.FileSystem, {
        ...fileSystem,
        stat: (entry) => fileSystem.stat(managedPath(entry)),
        readDirectory: (entry) => fileSystem.readDirectory(managedPath(entry)),
        readFileString: (entry) => fileSystem.readFileString(managedPath(entry)),
      }),
    );

    const installed = path.join(config, "plugins", "installed_plugins.json");
    for (const installPath of [
      path.join(config, "plugins", "marketplaces", "a"),
      path.join(config, "plugins", "store", "a"),
      path.join(config, "plugins"),
    ]) {
      yield* write(
        installed,
        JSON.stringify({
          plugins: { "a@b": [{ installPath }] },
        }),
      );
      yield* probesTwice(commands);
    }
    yield* write(
      installed,
      JSON.stringify({ plugins: { "a@b": [{ installPath: path.join(root, "elsewhere") }] } }),
    );
    yield* probesTwice(commands);
    yield* write(installed, "not json");
    yield* probesTwice(commands);
    yield* write(installed, '{"plugins":{}}');

    const marketplaces = path.join(config, "plugins", "known_marketplaces.json");
    yield* write(marketplaces, '{"local":{"source":{"source":"directory","path":"/elsewhere"}}}');
    yield* probesTwice(commands);
    yield* write(marketplaces, '{"remote":{"source":{"source":"github","repo":"a/b"}}}');
    const beforeRemote = probes();
    yield* commands.get(machine, cwd);
    yield* commands.get(machine, cwd);
    assert.strictEqual(probes(), beforeRemote + 1);

    for (let index = 0; index <= 2_000; index++) {
      yield* write(path.join(cwd, ".claude", "skills", `${index}.md`));
    }
    yield* probesTwice(commands);
  }).pipe(
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("keeps the probe subprocess alive while gateway model discovery can finish", () =>
  Effect.gen(function* () {
    let abortSignal: AbortSignal | undefined;
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
      abortSignal = options?.abortController?.signal;
      return {
        initializationResult: async () => ({
          account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },
          commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],
          models: [{ value: "gateway/claude-relay", displayName: "Relay", description: "" }],
        }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
          new Promise((_, reject) => reject(new Error("usage unavailable"))),
      } as ReturnType<typeof ClaudeSdk.query>;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const fileSystem = yield* FileSystem.FileSystem;
    const configDir = yield* fileSystem.makeTempDirectoryScoped();
    // Claude Code also reads these from settings.json, which is where gateway users set them.
    yield* fileSystem.writeFileString(
      `${configDir}/settings.json`,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://gateway.example",
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        },
      }),
    );
    const capabilities = yield* probeClaudeCapabilities(
      yield* decodeClaudeSettings({ binaryPath: "claude" }),
      { PATH: (yield* HostProcess.Environment).PATH, CLAUDE_CONFIG_DIR: configDir },
    );
    assert.deepEqual(
      capabilities.models?.map((model) => model.value),
      ["gateway/claude-relay"],
    );
    assert.equal(abortSignal?.aborted, false);
    yield* TestClock.adjust("3 seconds");
    assert.equal(abortSignal?.aborted, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
