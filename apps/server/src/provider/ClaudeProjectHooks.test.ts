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
import * as ClaudeProjectHookApprovalWrites from "./ClaudeProjectHookApprovalWrites.ts";
import * as ClaudeProjectHooks from "./ClaudeProjectHooks.ts";

const projectId = ProjectId.make("project:hooks");

/** `fileSystem` stands in for the machine's own where the service under test reaches for it. */
const layerHooks = (
  policy?: ManagedPolicyDocument,
  fileSystem?: (real: FileSystem.FileSystem) => Partial<FileSystem.FileSystem>,
) =>
  ClaudeProjectHookApprovalWrites.layer.pipe(
    Layer.provideMerge(
      fileSystem === undefined
        ? ClaudeProjectHooks.layer
        : ClaudeProjectHooks.layer.pipe(
            Layer.provide(
              Layer.effect(
                FileSystem.FileSystem,
                Effect.map(FileSystem.FileSystem, (real) => ({ ...real, ...fileSystem(real) })),
              ),
            ),
          ),
    ),
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
    .pipe(Effect.flatMap(({ hooksHash }) => writes.set({ projectId, cwd, hooksHash })));
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
          {
            kind: "hook",
            source: "project",
            event: "SessionStart",
            detail: "./scripts/setup.sh",
          },
          {
            kind: "hook",
            source: "project",
            event: "PreToolUse",
            matcher: "Bash",
            detail: "./scripts/check.sh",
          },
          { kind: "hook", source: "local", event: "Stop", detail: "say done" },
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
      const runs = session(false).pipe(Effect.map((opened) => opened?.notice === null));
      assert.isFalse(yield* runs);
      yield* approve;
      assert.isTrue(yield* runs);
      assert.strictEqual((yield* hooks.read({ projectId, cwd })).status, "approved");
      // Formatting and key order are not a change.
      yield* write(".claude/settings.json", JSON.stringify(first, null, 2));
      assert.isTrue(yield* runs);
      // Nor is a local file that declares nothing to approve.
      yield* write(".claude/settings.local.json", { permissions: { ask: ["Bash(git push:*)"] } });
      assert.isTrue(yield* runs);

      yield* write(".claude/settings.json", {
        hooks: { SessionStart: command("./scripts/setup.sh && curl example.test") },
      });
      assert.isFalse(yield* runs);
      assert.strictEqual((yield* hooks.read({ projectId, cwd })).status, "needs-approval");
      // Another checkout of the project may still hold the hooks approved before.
      yield* write(".claude/settings.json", first);
      assert.isTrue(yield* runs);

      yield* writes.set({ projectId, cwd, hooksHash: null });
      assert.isFalse(yield* runs);
    }),
  );

  it.effect("an approved session reads the hooks as they were approved, not the folder's", () =>
    Effect.gen(function* () {
      const { fileSystem, path, cwd, write, readJson, session, approve } = yield* fixture;
      const approved = {
        permissions: { deny: ["Read(./.env)"] },
        hooks: { SessionStart: command("./scripts/setup.sh") },
      };
      yield* write(".claude/settings.json", approved);
      yield* approve;
      const opened = yield* session(false);
      assert.isNotNull(opened);
      if (opened === null) return;
      assert.isNull(opened.notice);
      const settings = path.join(opened.projectConfigRoot, ".claude", "settings.json");
      assert.deepEqual(yield* readJson(settings), approved);

      // The folder changes after the check: the session that was checked still holds what it held.
      yield* write(".claude/settings.json", { hooks: { SessionStart: command("something else") } });
      assert.deepEqual(yield* readJson(settings), approved);
      // A session's own writes to the folder it reads do not reach the next one.
      yield* write(".claude/settings.json", approved);
      yield* write(path.relative(cwd, settings), { hooks: { Stop: command("left behind") } });
      yield* write(path.relative(cwd, path.join(settings, "..", "settings.local.json")), {
        hooks: { Stop: command("left behind") },
      });
      assert.strictEqual((yield* session(false))?.projectConfigRoot, opened.projectConfigRoot);
      assert.deepEqual(yield* readJson(settings), approved);
      assert.isFalse(yield* fileSystem.exists(path.join(settings, "..", "settings.local.json")));
    }),
  );

  it.effect("helper commands in the settings wait for approval with the hooks", () =>
    Effect.gen(function* () {
      const { path, hooks, cwd, write, readJson, session, approve } = yield* fixture;
      yield* write(".claude/settings.json", {
        apiKeyHelper: "./scripts/key.sh",
        env: { CLAUDE_CODE_USE_BEDROCK: "1" },
      });
      yield* write(".claude/settings.local.json", {
        awsAuthRefresh: "aws sso login",
        awsCredentialExport: "./scripts/aws.sh",
        gcpAuthRefresh: "gcloud auth login",
        otelHeadersHelper: "./scripts/otel.sh",
        proxyAuthHelper: "./scripts/proxy.sh",
      });
      const read = yield* hooks.read({ projectId, cwd });
      assert.strictEqual(read.status, "needs-approval");
      assert.deepEqual(read.hooks, [
        { kind: "helper", source: "project", event: "apiKeyHelper", detail: "./scripts/key.sh" },
        { kind: "helper", source: "local", event: "proxyAuthHelper", detail: "./scripts/proxy.sh" },
        { kind: "helper", source: "local", event: "awsAuthRefresh", detail: "aws sso login" },
        {
          kind: "helper",
          source: "local",
          event: "awsCredentialExport",
          detail: "./scripts/aws.sh",
        },
        { kind: "helper", source: "local", event: "gcpAuthRefresh", detail: "gcloud auth login" },
        {
          kind: "helper",
          source: "local",
          event: "otelHeadersHelper",
          detail: "./scripts/otel.sh",
        },
      ]);
      const opened = yield* session(false);
      assert.isNotNull(opened);
      if (opened === null) return;
      assert.include(opened.notice ?? "", "not approved");
      const root = path.join(opened.projectConfigRoot, ".claude");
      assert.deepEqual(yield* readJson(path.join(root, "settings.json")), {
        env: { CLAUDE_CODE_USE_BEDROCK: "1" },
      });
      assert.deepEqual(yield* readJson(path.join(root, "settings.local.json")), {});

      yield* approve;
      const approved = yield* session(false);
      assert.isNull(approved?.notice);
      assert.deepInclude(
        yield* readJson(path.join(approved?.projectConfigRoot ?? "", ".claude", "settings.json")),
        { apiKeyHelper: "./scripts/key.sh" },
      );
      // A helper that changes is a change to what was approved.
      yield* write(".claude/settings.json", { apiKeyHelper: "./scripts/other.sh" });
      assert.strictEqual((yield* hooks.read({ projectId, cwd })).status, "needs-approval");
    }),
  );

  it.effect("paths under the folder a session reads lead to the project's own files", () =>
    Effect.gen(function* () {
      const { fileSystem, path, write, session } = yield* fixture;
      yield* write(".claude/settings.json", { hooks: { SessionStart: command("make") } });
      yield* write("scripts/server.sh", "#!/bin/sh\n");
      yield* write("package.json", "{}");
      yield* write(".git/HEAD", "ref: refs/heads/main\n");
      const opened = yield* session(false);
      assert.isNotNull(opened);
      if (opened === null) return;
      const root = opened.projectConfigRoot;
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(root, "scripts", "server.sh")),
        "#!/bin/sh\n",
      );
      assert.isTrue(yield* fileSystem.exists(path.join(root, "package.json")));
      // Git run there would take the links for the project's files, so it finds no repository.
      assert.isFalse(yield* fileSystem.exists(path.join(root, ".git")));
      // A file the project gains is there for the next session.
      yield* write("Makefile", "all:\n");
      const next = yield* session(false);
      assert.isTrue(yield* fileSystem.exists(path.join(next?.projectConfigRoot ?? "", "Makefile")));
    }),
  );

  it.effect("the project counts the sets approved for it, wherever they were approved", () =>
    Effect.gen(function* () {
      const { hooks, cwd, write, writes } = yield* fixture;
      const counted = { projectId: ProjectId.make("project:counted"), cwd };
      assert.strictEqual((yield* hooks.read(counted)).approvals, 0);
      yield* write(".claude/settings.json", { hooks: { SessionStart: command("make") } });
      yield* writes.set({ ...counted, hooksHash: (yield* hooks.read(counted)).hooksHash });
      // The folder read here declares none, as a project root does whose branch has no hooks.
      yield* write(".claude/settings.json", {});
      const read = yield* hooks.read(counted);
      assert.deepEqual([read.status, read.approvals], ["none", 1]);
      assert.strictEqual((yield* writes.set({ ...counted, hooksHash: null })).approvals, 0);
    }),
  );

  it.effect("hooks that changed since they were shown are not approved", () =>
    Effect.gen(function* () {
      const { hooks, cwd, write, writes } = yield* fixture;
      yield* write(".claude/settings.json", { hooks: { SessionStart: command("make") } });
      const shown = yield* hooks.read({ projectId, cwd });
      yield* write(".claude/settings.json", { hooks: { SessionStart: command("make all") } });
      const result = yield* writes
        .set({ projectId, cwd, hooksHash: shown.hooksHash })
        .pipe(Effect.flip);
      assert.include(result.detail, "changed since they were shown");
      assert.strictEqual((yield* hooks.read({ projectId, cwd })).status, "needs-approval");
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

  // Claude Code on Windows reads a worktree's own local file only.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "a worktree counts the local file of its main checkout",
    () =>
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
          { kind: "hook", source: "local", event: "SessionStart", detail: "main-local" },
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
  layerHooks(undefined, (real) => ({
    // As on Windows without developer mode.
    symlink: () => real.readLink("/t3-no-such-folder/link").pipe(Effect.asVoid),
  })),
)("ClaudeProjectHooks where links cannot be made", (it) => {
  it.effect("each session reads the project's commands as they are when it starts", () =>
    Effect.gen(function* () {
      const { fileSystem, path, write, session } = yield* fixture;
      yield* write(".claude/settings.json", { hooks: { SessionStart: command("make") } });
      yield* write(".claude/commands/review.md", "Review the change.\n");
      yield* write(".mcp.json", { mcpServers: {} });
      const command_ = (root: string | undefined) =>
        fileSystem.readFileString(path.join(root ?? "", ".claude", "commands", "review.md"));
      const first = yield* session(false);
      assert.strictEqual(yield* command_(first?.projectConfigRoot), "Review the change.\n");
      assert.strictEqual((yield* session(false))?.projectConfigRoot, first?.projectConfigRoot);

      yield* write(".claude/commands/review.md", "Review it twice.\n");
      yield* write(".mcp.json", { mcpServers: { docs: { command: "docs-server" } } });
      const second = yield* session(false);
      assert.strictEqual(yield* command_(second?.projectConfigRoot), "Review it twice.\n");
      assert.include(
        yield* fileSystem.readFileString(path.join(second?.projectConfigRoot ?? "", ".mcp.json")),
        "docs-server",
      );
      // The session that started earlier keeps the files it started with.
      assert.strictEqual(yield* command_(first?.projectConfigRoot), "Review the change.\n");
    }),
  );
});

it.layer(
  layerHooks(undefined, (real) => ({
    rename: () => real.readLink("/t3-no-such-folder/link").pipe(Effect.asVoid),
  })),
)("ClaudeProjectHooks where the settings folder cannot be put in place", (it) => {
  it.effect("the session does not open on a folder that is not there", () =>
    Effect.gen(function* () {
      const { write, session } = yield* fixture;
      yield* write(".claude/settings.json", { hooks: { SessionStart: command("make") } });
      const failure = yield* session(false).pipe(Effect.flip);
      assert.include(failure.detail, "Could not prepare");
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
