import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type ManagedPolicyDocument, ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ClaudeProjectTrust from "./ClaudeProjectTrust.ts";
import * as ClaudeProjectTrustWrites from "./ClaudeProjectTrustWrites.ts";

const projectId = ProjectId.make("project:trust");

const layerTrust = (policy?: ManagedPolicyDocument) =>
  Layer.merge(ClaudeProjectTrustWrites.layer, ClaudeProjectTrust.layer).pipe(
    Layer.provide(ManagedPolicy.layerTest(policy)),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-trust-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const command = (text: string) => [{ hooks: [{ type: "command", command: text }] }];

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const trust = yield* ClaudeProjectTrust.ClaudeProjectTrust;
  const writes = yield* ClaudeProjectTrustWrites.ClaudeProjectTrustWrites;
  const cwd = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-trust-" }),
  );
  const write = Effect.fnUntraced(function* (relative: string, value: unknown) {
    const file = path.join(cwd, relative);
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(
      file,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  });
  const readJson = (file: string) =>
    fileSystem.readFileString(file).pipe(Effect.map((text) => JSON.parse(text) as unknown));
  const session = (fullAccess: boolean, name = "session") =>
    trust.forSession({ projectId, cwd, session: name, fullAccess });
  return { fileSystem, path, trust, writes, cwd, write, readJson, session };
});

it.layer(layerTrust())("ClaudeProjectTrust", (it) => {
  it.effect("a folder with nothing to run is opened as it is and has nothing to trust", () =>
    Effect.gen(function* () {
      const { trust, cwd, write, session } = yield* fixture;
      assert.isNull(yield* session(false));
      yield* write(".claude/settings.json", { permissions: { deny: ["Read(./.env)"] }, hooks: {} });
      yield* write(".mcp.json", { mcpServers: {} });
      assert.isNull(yield* session(false));
      assert.deepEqual(yield* trust.read({ projectId, cwd }), {
        status: "untrusted",
        commands: [],
      });
    }),
  );

  it.effect("lists what the folder would run: hooks, helper commands, servers and env", () =>
    Effect.gen(function* () {
      const { trust, cwd, write } = yield* fixture;
      yield* write(".claude/settings.json", {
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "./scripts/check.sh" }] },
          ],
        },
        apiKeyHelper: "./scripts/key.sh",
        env: { BASH_ENV: "./scripts/env.sh" },
      });
      yield* write(".claude/settings.local.json", { hooks: { Stop: command("say done") } });
      yield* write(".mcp.json", {
        mcpServers: {
          files: { command: "node", args: ["./scripts/server.js"] },
          remote: { type: "http", url: "https://example.com/mcp" },
        },
      });
      assert.deepEqual((yield* trust.read({ projectId, cwd })).commands, [
        {
          kind: "hook",
          source: "project",
          event: "PreToolUse",
          matcher: "Bash",
          detail: "./scripts/check.sh",
        },
        { kind: "helper", source: "project", event: "apiKeyHelper", detail: "./scripts/key.sh" },
        { kind: "env", source: "project", event: "BASH_ENV", detail: "./scripts/env.sh" },
        { kind: "hook", source: "local", event: "Stop", detail: "say done" },
        { kind: "mcp", source: "mcp", event: "files", detail: "node ./scripts/server.js" },
        { kind: "mcp", source: "mcp", event: "remote", detail: "https://example.com/mcp" },
      ]);
    }),
  );

  // One case per thing the folder can run, so each is known to send the session to the substitute.
  it.effect.each([
    ["a hook", ".claude/settings.json", { hooks: { SessionStart: command("./setup.sh") } }],
    ["a local hook", ".claude/settings.local.json", { hooks: { Stop: command("say done") } }],
    ["a helper command", ".claude/settings.json", { otelHeadersHelper: "./headers.sh" }],
    ["an env variable", ".claude/settings.json", { env: { BASH_ENV: "./env.sh" } }],
    ["an MCP server", ".mcp.json", { mcpServers: { files: { command: "./server.sh" } } }],
  ] as const)(
    "below Full access, an untrusted session of a folder with %s leaves it out",
    ([, file, contents]) =>
      Effect.gen(function* () {
        const { fileSystem, path, write, readJson, session } = yield* fixture;
        yield* write(file, contents);
        const opened = yield* session(false);
        assert.isNotNull(opened);
        if (opened === null) return;
        assert.include(opened.notice, "not trusted");
        assert.deepEqual(yield* fileSystem.readDirectory(opened.projectConfigRoot), [".claude"]);
        assert.deepEqual(
          yield* fileSystem.readDirectory(path.join(opened.projectConfigRoot, ".claude")),
          ["settings.json"],
        );
        assert.deepEqual(
          yield* readJson(path.join(opened.projectConfigRoot, ".claude", "settings.json")),
          { permissions: { deny: [], ask: [] } },
        );
      }),
  );

  it.effect("an untrusted session keeps the folder's deny and ask rules and its files", () =>
    Effect.gen(function* () {
      const { fileSystem, path, cwd, write, readJson, session } = yield* fixture;
      yield* write(".claude/settings.json", {
        permissions: { deny: ["Read(./.env)"], allow: ["Bash(*)"], defaultMode: "acceptEdits" },
        hooks: { SessionStart: command("./scripts/setup.sh") },
        model: "opus",
      });
      yield* write(".claude/settings.local.json", {
        permissions: { deny: ["Read(./keys/**)"], ask: ["Bash(git push:*)"] },
      });
      yield* write(".claude/commands/review.md", "Review the change.\n");
      yield* write(".claude/skills/check/SKILL.md", "Check.\n");
      yield* write(".mcp.json", { mcpServers: { files: { command: "./scripts/server.sh" } } });
      yield* write("scripts/setup.sh", "#!/bin/sh\n");
      yield* write(".git/HEAD", "ref: refs/heads/main\n");

      const opened = yield* session(false);
      assert.isNotNull(opened);
      if (opened === null) return;
      const root = opened.projectConfigRoot;
      assert.notStrictEqual(root, cwd);
      // Only rules that restrict are carried over.
      assert.deepEqual(yield* readJson(path.join(root, ".claude", "settings.json")), {
        permissions: { deny: ["Read(./.env)", "Read(./keys/**)"], ask: ["Bash(git push:*)"] },
      });
      assert.deepEqual((yield* fileSystem.readDirectory(path.join(root, ".claude"))).toSorted(), [
        "commands",
        "settings.json",
        "skills",
      ]);
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(root, ".claude", "commands", "review.md")),
        "Review the change.\n",
      );
      // The project's files are reachable for the user's own hooks; its servers and Git folder are not.
      assert.deepEqual((yield* fileSystem.readDirectory(root)).toSorted(), [".claude", "scripts"]);
      assert.isTrue(yield* fileSystem.exists(path.join(root, "scripts", "setup.sh")));
    }),
  );

  it.effect("each session gets its own folder, made anew at every start", () =>
    Effect.gen(function* () {
      const { fileSystem, path, write, readJson, session } = yield* fixture;
      yield* write(".claude/settings.json", { hooks: { SessionStart: command("./setup.sh") } });
      const first = yield* session(false, "one");
      const second = yield* session(false, "two");
      assert.isNotNull(first);
      assert.isNotNull(second);
      if (first === null || second === null) return;
      assert.notStrictEqual(first.projectConfigRoot, second.projectConfigRoot);

      // What a session wrote into its folder is gone when that session starts again.
      const settings = path.join(first.projectConfigRoot, ".claude", "settings.json");
      yield* fileSystem.writeFileString(settings, JSON.stringify({ hooks: { Stop: [] } }));
      yield* fileSystem.writeFileString(
        path.join(first.projectConfigRoot, ".claude", "settings.local.json"),
        "{}",
      );
      const again = yield* session(false, "one");
      assert.strictEqual(again?.projectConfigRoot, first.projectConfigRoot);
      assert.deepEqual(yield* readJson(settings), { permissions: { deny: [], ask: [] } });
      assert.deepEqual(
        yield* fileSystem.readDirectory(path.join(first.projectConfigRoot, ".claude")),
        ["settings.json"],
      );
    }),
  );

  it.effect("listing a folder's commands reads a folder of its own, trusted or not", () =>
    Effect.gen(function* () {
      const { fileSystem, path, trust, writes, cwd, write, readJson } = yield* fixture;
      assert.isNull(yield* Effect.scoped(trust.forListing(cwd)));
      yield* write(".claude/settings.json", {
        apiKeyHelper: "./key.sh",
        permissions: { deny: ["Read(./.env)"] },
      });
      yield* write(".claude/commands/review.md", "Review the change.\n");
      yield* writes.set({ projectId, trusted: true });
      const root = yield* Effect.scoped(
        Effect.gen(function* () {
          const listed = yield* trust.forListing(cwd);
          assert.isNotNull(listed);
          if (listed === null) return listed;
          assert.deepEqual(yield* readJson(path.join(listed, ".claude", "settings.json")), {
            permissions: { deny: ["Read(./.env)"], ask: [] },
          });
          assert.isTrue(
            yield* fileSystem.exists(path.join(listed, ".claude", "commands", "review.md")),
          );
          return listed;
        }),
      );
      // Kept only while the listing runs.
      assert.isFalse(root === null || (yield* fileSystem.exists(root)));
      yield* writes.set({ projectId, trusted: false });
    }),
  );

  it.effect("a trusted project opens on its folder, whatever its settings become", () =>
    Effect.gen(function* () {
      const { trust, writes, cwd, write, session } = yield* fixture;
      yield* write(".claude/settings.json", { hooks: { SessionStart: command("./setup.sh") } });
      assert.isNotNull(yield* session(false));

      yield* writes.set({ projectId, trusted: true });
      assert.isNull(yield* session(false));
      assert.strictEqual((yield* trust.read({ projectId, cwd })).status, "trusted");

      // Trust is for the project, not for what its files held when it was given.
      yield* write(".claude/settings.json", {
        hooks: { SessionStart: command("./other.sh"), Stop: command("say done") },
        env: { BASH_ENV: "./env.sh" },
      });
      assert.isNull(yield* session(false));
      assert.strictEqual((yield* trust.read({ projectId, cwd })).status, "trusted");

      // Another project is not trusted with it.
      const other = ProjectId.make("project:other");
      assert.strictEqual((yield* trust.read({ projectId: other, cwd })).status, "untrusted");
      assert.isNotNull(
        yield* trust.forSession({ projectId: other, cwd, session: "s", fullAccess: false }),
      );

      yield* writes.set({ projectId, trusted: false });
      assert.strictEqual((yield* trust.read({ projectId, cwd })).status, "untrusted");
      assert.isNotNull(yield* session(false));
    }),
  );

  // Claude Code on Windows reads a worktree's own local file only.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "a worktree counts the local file of its main checkout",
    () =>
      Effect.gen(function* () {
        const { path, trust, cwd, write, readJson } = yield* fixture;
        const worktree = path.join(cwd, "worktree");
        yield* write(".git/worktrees/side/commondir", "../..\n");
        yield* write("worktree/.git", `gitdir: ${path.join(cwd, ".git", "worktrees", "side")}\n`);
        yield* write(".claude/settings.local.json", {
          permissions: { deny: ["Read(./main.txt)"] },
          hooks: { Stop: command("say done") },
        });
        yield* write("worktree/.claude/settings.local.json", {
          permissions: { deny: ["Read(./worktree.txt)"] },
        });
        assert.deepEqual((yield* trust.read({ projectId, cwd: worktree })).commands, [
          { kind: "hook", source: "local", event: "Stop", detail: "say done" },
        ]);
        const opened = yield* trust.forSession({
          projectId,
          cwd: worktree,
          session: "worktree",
          fullAccess: false,
        });
        assert.isNotNull(opened);
        if (opened === null) return;
        assert.deepEqual(
          yield* readJson(path.join(opened.projectConfigRoot, ".claude", "settings.json")),
          { permissions: { deny: ["Read(./worktree.txt)", "Read(./main.txt)"], ask: [] } },
        );
      }),
  );

  it.effect("Full access opens an untrusted project on its folder without asking", () =>
    Effect.gen(function* () {
      const { write, session } = yield* fixture;
      yield* write(".claude/settings.json", { hooks: { SessionStart: command("./setup.sh") } });
      yield* write(".mcp.json", { mcpServers: { files: { command: "./server.sh" } } });
      assert.isNull(yield* session(true));
    }),
  );
});

it.layer(
  layerTrust({
    schemaVersion: 1,
    organization: "Example Corp",
    limits: { claudeProjectHooks: false },
  }),
)("ClaudeProjectTrust under a policy that lets no project be trusted", (it) => {
  it.effect("every mode leaves the folder's commands out, and no project can be trusted", () =>
    Effect.gen(function* () {
      const { trust, writes, cwd, write, session } = yield* fixture;
      yield* write(".claude/settings.json", { hooks: { SessionStart: command("./setup.sh") } });
      assert.strictEqual((yield* trust.read({ projectId, cwd })).status, "off");

      const error = yield* writes.set({ projectId, trusted: true }).pipe(Effect.flip);
      assert.include(error.message, "Example Corp's policy does not allow");
      assert.strictEqual((yield* trust.read({ projectId, cwd })).status, "off");

      for (const fullAccess of [false, true]) {
        const opened = yield* session(fullAccess);
        assert.include(opened?.notice ?? "", "Example Corp's policy does not allow");
      }
      // Withdrawing is still possible.
      yield* writes.set({ projectId, trusted: false });
    }),
  );
});
