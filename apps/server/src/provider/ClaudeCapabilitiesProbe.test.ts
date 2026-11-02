// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, type ServerProvider } from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  makeClaudeWorkspaceCommands,
  probeClaudeWorkspaceSnapshot,
} from "./ClaudeProvider.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

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
  const makeCommands = (environment: NodeJS.ProcessEnv = {}) =>
    makeClaudeWorkspaceCommands({ homePath: config }, environment, () =>
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
      path.join(config, "remote-settings.json"),
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
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("starts the CLI again when the health check's view of it changes", () =>
  Effect.gen(function* () {
    const { cwd, makeCommands, probes } = yield* makeCommandSourcesFixture;
    const commands = yield* makeCommands();
    yield* commands.get(machine, cwd);
    yield* commands.get({ ...machine, version: "1.0.1" }, cwd);
    assert.strictEqual(probes(), 2);
    yield* commands.get({ ...machine, auth: { status: "unauthenticated" } }, cwd);
    assert.strictEqual(probes(), 3);
    yield* commands.get({ ...machine, slashCommands: [{ name: "upgrade" }] }, cwd);
    assert.strictEqual(probes(), 4);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps folders apart, retries failures, and forgets on invalidate", () =>
  Effect.gen(function* () {
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
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("always starts the CLI when its sources cannot be vouched for", () =>
  Effect.gen(function* () {
    const { path, write, root, cwd, config, makeCommands, probes } =
      yield* makeCommandSourcesFixture;
    const probesTwice = (commands: Effect.Success<ReturnType<typeof makeCommands>>) =>
      Effect.gen(function* () {
        const before = probes();
        yield* commands.get(machine, cwd);
        yield* commands.get(machine, cwd);
        assert.strictEqual(probes(), before + 2);
      });

    yield* probesTwice(yield* makeCommands({ CLAUDE_CODE_PLUGIN_DIRS: "/elsewhere" }));

    const commands = yield* makeCommands();
    const settings = path.join(cwd, ".claude", "settings.json");
    yield* write(settings, '{"env":{"CLAUDE_CODE_PLUGIN_SEED_DIR":"/elsewhere"}}');
    yield* probesTwice(commands);
    yield* write(settings, "{}");

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

    const installed = path.join(config, "plugins", "installed_plugins.json");
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
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
