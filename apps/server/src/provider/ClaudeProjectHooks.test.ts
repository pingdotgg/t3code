import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type ManagedPolicyDocument, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ClaudeProjectHookApprovalWrites from "./ClaudeProjectHookApprovalWrites.ts";
import * as ClaudeProjectHooks from "./ClaudeProjectHooks.ts";

const projectId = ProjectId.make("project:hooks");

const layerHooks = (policy?: ManagedPolicyDocument) =>
  Layer.merge(ClaudeProjectHooks.layer, ClaudeProjectHookApprovalWrites.layer).pipe(
    Layer.provide(ManagedPolicy.layerTest(policy)),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-claude-hooks-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const command = (text: string) => [{ hooks: [{ type: "command", command: text }] }];

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hooks = yield* ClaudeProjectHooks.ClaudeProjectHooks;
  const writes = yield* ClaudeProjectHookApprovalWrites.ClaudeProjectHookApprovalWrites;
  const cwd = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-hooks-" }),
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
  const session = (fullAccess: boolean) => hooks.forSession({ projectId, cwd, fullAccess });
  /** Approves the hooks the folder declares now, the way the client RPC records a person's approval. */
  const approve = hooks
    .read({ projectId, cwd })
    .pipe(Effect.flatMap(({ hooksHash }) => writes.set({ projectId, hooksHash })));
  return { fileSystem, path, hooks, writes, cwd, write, readJson, session, approve };
});

it.layer(layerHooks())("ClaudeProjectHooks", (it) => {
  it.effect("a folder that declares no hooks is opened as it is and never asks", () =>
    Effect.gen(function* () {
      const { hooks, cwd, write, session } = yield* fixture;
      assert.isNull(yield* session(false));
      yield* write(".claude/settings.json", { permissions: { deny: ["Read(./.env)"] }, hooks: {} });
      assert.isNull(yield* session(false));
      assert.deepEqual(
        yield* hooks.read({ projectId, cwd }).pipe(Effect.map((r) => r.status)),
        "none",
      );
    }),
  );

  it.effect(
    "below Full access, a session leaves out hooks nobody approved and keeps the rest",
    () =>
      Effect.gen(function* () {
        const { fileSystem, path, hooks, cwd, write, readJson, session } = yield* fixture;
        yield* write(".claude/settings.json", {
          permissions: { deny: ["Read(./.env)"] },
          hooks: {
            SessionStart: command("./scripts/setup.sh"),
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: "./scripts/check.sh" }] },
            ],
          },
        });
        yield* write(".claude/settings.local.json", {
          permissions: { ask: ["Bash(git push:*)"] },
          hooks: { Stop: command("say done") },
        });
        yield* write(".claude/commands/review.md", "Review the change.\n");
        yield* write(".mcp.json", { mcpServers: {} });

        const read = yield* hooks.read({ projectId, cwd });
        assert.strictEqual(read.status, "needs-approval");
        assert.deepEqual(read.hooks, [
          { source: "project", event: "SessionStart", detail: "./scripts/setup.sh" },
          { source: "project", event: "PreToolUse", matcher: "Bash", detail: "./scripts/check.sh" },
          { source: "local", event: "Stop", detail: "say done" },
        ]);

        const opened = yield* session(false);
        assert.isNotNull(opened);
        if (opened === null) return;
        assert.include(opened.notice, "not approved");
        const root = opened.projectConfigRoot;
        assert.notStrictEqual(root, cwd);
        assert.deepEqual(yield* readJson(path.join(root, ".claude", "settings.json")), {
          permissions: { deny: ["Read(./.env)"] },
        });
        assert.deepEqual(yield* readJson(path.join(root, ".claude", "settings.local.json")), {
          permissions: { ask: ["Bash(git push:*)"] },
        });
        assert.strictEqual(
          yield* fileSystem.readFileString(path.join(root, ".claude", "commands", "review.md")),
          "Review the change.\n",
        );
        assert.isTrue(yield* fileSystem.exists(path.join(root, ".mcp.json")));
        // The same folder serves the next session that agrees with it.
        assert.strictEqual((yield* session(false))?.projectConfigRoot, root);
      }),
  );

  it.effect("approved hooks run, and hooks that change wait for approval again", () =>
    Effect.gen(function* () {
      const { hooks, cwd, write, session, approve, writes } = yield* fixture;
      const first = { hooks: { SessionStart: command("./scripts/setup.sh") } };
      yield* write(".claude/settings.json", first);
      assert.isNotNull(yield* session(false));
      yield* approve;
      assert.isNull(yield* session(false));
      assert.strictEqual((yield* hooks.read({ projectId, cwd })).status, "approved");
      // Formatting and key order are not a change.
      yield* write(".claude/settings.json", JSON.stringify(first, null, 2));
      assert.isNull(yield* session(false));

      yield* write(".claude/settings.json", {
        hooks: { SessionStart: command("./scripts/setup.sh && curl example.test") },
      });
      assert.isNotNull(yield* session(false));
      assert.strictEqual((yield* hooks.read({ projectId, cwd })).status, "needs-approval");
      // Another checkout of the project may still hold the hooks approved before.
      yield* write(".claude/settings.json", first);
      assert.isNull(yield* session(false));

      yield* writes.set({ projectId, hooksHash: null });
      assert.isNotNull(yield* session(false));
    }),
  );

  it.effect("an approval covers one project", () =>
    Effect.gen(function* () {
      const { hooks, cwd, write, approve } = yield* fixture;
      yield* write(".claude/settings.json", { hooks: { SessionStart: command("make") } });
      yield* approve;
      assert.isNotNull(
        yield* hooks.forSession({
          projectId: ProjectId.make("project:other"),
          cwd,
          fullAccess: false,
        }),
      );
    }),
  );

  it.effect("a thread in Full access runs the folder's hooks without an approval", () =>
    Effect.gen(function* () {
      const { write, session } = yield* fixture;
      yield* write(".claude/settings.json", { hooks: { SessionStart: command("make") } });
      assert.isNull(yield* session(true));
    }),
  );

  it.effect("a worktree counts the local file of its main checkout", () =>
    Effect.gen(function* () {
      const { fileSystem, path, hooks, cwd, write, readJson } = yield* fixture;
      const worktree = path.join(cwd, "worktree");
      yield* write(".git/worktrees/side/commondir", "../..\n");
      yield* write("worktree/.git", `gitdir: ${path.join(cwd, ".git", "worktrees", "side")}\n`);
      yield* write(".claude/settings.local.json", {
        permissions: { deny: ["Read(./main.txt)"] },
        hooks: { SessionStart: command("main-local") },
      });
      yield* write("worktree/.claude/settings.local.json", {
        permissions: { deny: ["Read(./worktree.txt)"] },
      });
      const read = yield* hooks.read({ projectId, cwd: worktree });
      assert.deepEqual(read.hooks, [
        { source: "local", event: "SessionStart", detail: "main-local" },
      ]);
      const opened = yield* hooks.forSession({ projectId, cwd: worktree, fullAccess: false });
      assert.isNotNull(opened);
      if (opened === null) return;
      assert.isFalse(
        yield* fileSystem.exists(path.join(opened.projectConfigRoot, ".claude", "settings.json")),
      );
      assert.deepEqual(
        yield* readJson(path.join(opened.projectConfigRoot, ".claude", "settings.local.json")),
        { permissions: { deny: ["Read(./worktree.txt)", "Read(./main.txt)"] } },
      );
    }),
  );
});

it.layer(
  layerHooks({
    schemaVersion: 1,
    organization: "Example Corp",
    limits: { claudeProjectHooks: false },
  }),
)("ClaudeProjectHooks under a policy that turns project hooks off", (it) => {
  it.effect("no session runs them, approved or in Full access", () =>
    Effect.gen(function* () {
      const { hooks, cwd, write, session, approve } = yield* fixture;
      yield* write(".claude/settings.json", { hooks: { SessionStart: command("make") } });
      yield* approve;
      assert.strictEqual((yield* hooks.read({ projectId, cwd })).status, "off");
      const opened = yield* session(true);
      assert.isNotNull(opened);
      assert.include(opened?.notice ?? "", "Example Corp");
    }),
  );
});
