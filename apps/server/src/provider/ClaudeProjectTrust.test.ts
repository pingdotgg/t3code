import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type ManagedPolicyDocument, ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ClaudeProjectTrust from "./ClaudeProjectTrust.ts";
import * as ClaudeProjectTrustWrites from "./ClaudeProjectTrustWrites.ts";

const projectId = ProjectId.make("project:trust");

const layerTrust = (policy?: ManagedPolicyDocument) =>
  Layer.merge(ClaudeProjectTrustWrites.layer, ClaudeProjectTrust.layer).pipe(
    Layer.provide(ManagedPolicy.layerTest(policy)),
    Layer.provideMerge(SqlitePersistence.layerMemory),
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

  it.effect("each start gets a folder of its own, kept while its session lasts", () =>
    Effect.gen(function* () {
      const { fileSystem, path, write, readJson, session } = yield* fixture;
      yield* write(".claude/settings.json", { hooks: { SessionStart: command("./setup.sh") } });
      const scope = yield* Scope.make();
      const first = yield* session(false, "one").pipe(Scope.provide(scope));
      const second = yield* session(false, "two");
      assert.isNotNull(first);
      assert.isNotNull(second);
      if (first === null || second === null) return;
      assert.notStrictEqual(first.projectConfigRoot, second.projectConfigRoot);

      // What a start wrote into its folder is gone when that session starts again.
      yield* fileSystem.writeFileString(
        path.join(first.projectConfigRoot, ".claude", "settings.local.json"),
        JSON.stringify({ hooks: { Stop: [] } }),
      );
      const again = yield* session(false, "one");
      assert.isNotNull(again);
      if (again === null) return;
      assert.isFalse(yield* fileSystem.exists(first.projectConfigRoot));
      assert.deepEqual(
        yield* fileSystem.readDirectory(path.join(again.projectConfigRoot, ".claude")),
        ["settings.json"],
      );
      assert.deepEqual(
        yield* readJson(path.join(again.projectConfigRoot, ".claude", "settings.json")),
        {
          permissions: { deny: [], ask: [] },
        },
      );

      // The earlier session closing takes only its own folder, not the one that replaced it.
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(yield* fileSystem.exists(again.projectConfigRoot));
      assert.isTrue(yield* fileSystem.exists(second.projectConfigRoot));
    }),
  );

  it.effect("a session's folder is removed when the session closes", () =>
    Effect.gen(function* () {
      const { fileSystem, write, session } = yield* fixture;
      yield* write(".claude/settings.json", { hooks: { SessionStart: command("./setup.sh") } });
      const root = yield* Effect.scoped(
        Effect.gen(function* () {
          const opened = yield* session(false, "closing");
          assert.isTrue(opened !== null && (yield* fileSystem.exists(opened.projectConfigRoot)));
          return opened?.projectConfigRoot;
        }),
      );
      assert.isFalse(root === undefined || (yield* fileSystem.exists(root)));
    }),
  );

  it.effect("outside a session, an untrusted project's folder is read through a substitute", () =>
    Effect.gen(function* () {
      const { fileSystem, path, trust, cwd, write, readJson } = yield* fixture;
      assert.isNull(yield* Effect.scoped(trust.forFolder({ cwd, projectId })));
      yield* write(".claude/settings.json", {
        apiKeyHelper: "./key.sh",
        permissions: { deny: ["Read(./.env)"] },
      });
      yield* write(".claude/commands/review.md", "Review the change.\n");
      const root = yield* Effect.scoped(
        Effect.gen(function* () {
          const substitute = yield* trust.forFolder({ cwd, projectId });
          assert.isNotNull(substitute);
          if (substitute === null) return substitute;
          assert.deepEqual(yield* readJson(path.join(substitute, ".claude", "settings.json")), {
            permissions: { deny: ["Read(./.env)"], ask: [] },
          });
          assert.isTrue(
            yield* fileSystem.exists(path.join(substitute, ".claude", "commands", "review.md")),
          );
          return substitute;
        }),
      );
      // Kept only while what asked for it runs.
      assert.isFalse(root === null || (yield* fileSystem.exists(root)));
    }),
  );

  it.effect("outside a session, a trusted project's folder is read as it is", () =>
    Effect.gen(function* () {
      const { trust, writes, cwd, write } = yield* fixture;
      yield* write(".claude/settings.json", { apiKeyHelper: "./key.sh" });
      const folder = (id?: ProjectId) => Effect.scoped(trust.forFolder({ cwd, projectId: id }));
      yield* writes.set({ projectId, trusted: true });
      assert.isNull(yield* folder(projectId));
      // Another project's trust does not cover it, and neither does a folder no project has.
      assert.isNotNull(yield* folder(ProjectId.make("project:other")));
      assert.isNotNull(yield* folder());
      yield* writes.set({ projectId, trusted: false });
    }),
  );

  it.effect("a folder is looked up among project folders and thread worktrees", () =>
    Effect.gen(function* () {
      const { path, trust, writes, cwd, write } = yield* fixture;
      const sql = yield* SqlClient.SqlClient;
      const worktree = path.join(cwd, "worktree");
      yield* write(".claude/settings.json", { apiKeyHelper: "./key.sh" });
      yield* write("worktree/.claude/settings.json", { apiKeyHelper: "./key.sh" });
      const folder = (folderCwd: string) => Effect.scoped(trust.forFolder({ cwd: folderCwd }));
      const lookedUp = ProjectId.make("project:looked-up");
      yield* sql`
        INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES (${lookedUp}, 'Looked up', ${cwd}, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      const thread = (id: string, projectIdOfThread: ProjectId, deletedAt: string | null) => sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, deleted_at, payload_json
        ) VALUES (
          ${id}, ${projectIdOfThread}, 'Thread', 'claudeAgent', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${deletedAt},
          ${JSON.stringify({ worktreePath: worktree })}
        )
      `;
      yield* thread("thread:worktree", lookedUp, null);

      // Known, and not trusted yet.
      assert.isNotNull(yield* folder(cwd));
      assert.isNotNull(yield* folder(worktree));
      yield* writes.set({ projectId: lookedUp, trusted: true });
      assert.isNull(yield* folder(cwd));
      assert.isNull(yield* folder(worktree));
      // A folder under the project that is neither is not covered.
      yield* write("nested/.claude/settings.json", { apiKeyHelper: "./key.sh" });
      assert.isNotNull(yield* folder(path.join(cwd, "nested")));
      // A deleted thread's worktree does not count for its project.
      yield* thread("thread:deleted", ProjectId.make("project:gone"), "2026-01-02T00:00:00.000Z");
      assert.isNull(yield* folder(worktree));
      // A worktree shared with a project that is not trusted is not trusted.
      yield* thread("thread:shared", ProjectId.make("project:untrusted"), null);
      assert.isNotNull(yield* folder(worktree));
      yield* writes.set({ projectId: lookedUp, trusted: false });
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
      // Outside a session too, whatever project the folder belongs to.
      assert.isNotNull(yield* Effect.scoped(trust.forFolder({ cwd, projectId })));
      // Withdrawing is still possible.
      yield* writes.set({ projectId, trusted: false });
    }),
  );
});
