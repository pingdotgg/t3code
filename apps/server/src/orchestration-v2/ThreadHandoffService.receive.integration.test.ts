import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadHandoffId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  OrchestrationV2HandoffBundleV1,
  type OrchestrationV2HandoffBundleV1 as OrchestrationV2HandoffBundleV1Type,
  type OrchestrationV2HandoffPart,
  type OrchestrationV2HandoffPartKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import { layer as projectionStoreLayer } from "./ProjectionStore.ts";
import { OrchestrationV2EventSinkLayerLive, ProjectServiceLayerLive } from "./runtimeLayer.ts";
import * as ThreadHandoffGit from "./ThreadHandoffGit.ts";
import * as ThreadHandoffService from "./ThreadHandoffService.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-handoff-receive-",
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");

// Only `driver` is read by the handoff service, and only while preparing.
const ProviderAdapterRegistryTestLayer = Layer.succeed(ProviderAdapterRegistryV2, {
  get: () => Effect.succeed({ driver } as ProviderAdapterV2Shape),
  list: () => Effect.succeed([modelSelection.instanceId]),
});

// The project service pulls in the whole application data plane; nothing in
// the handoff paths reads enrichment, so it is stubbed out flat.
const ProjectEnrichmentTestLayer = Layer.succeed(ProjectEnrichmentService, {
  peek: () =>
    Effect.succeed({
      repositoryIdentity: null,
      faviconPath: null,
      repositoryIdentityResolved: false,
    }),
  request: () => Effect.void,
  getAvailable: () =>
    Effect.succeed({
      repositoryIdentity: null,
      faviconPath: null,
      repositoryIdentityResolved: false,
    }),
  invalidate: () => Effect.void,
  subscribeChanges: Effect.never,
});

const HandoffLayer = ThreadHandoffService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      projectionStoreLayer,
      OrchestrationV2EventSinkLayerLive,
      ProjectServiceLayerLive,
      ProviderAdapterRegistryTestLayer,
      RepositoryIdentityResolver.layer,
      ServerEnvironment.layer,
      ThreadHandoffGit.layer,
    ),
  ),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provide(Layer.merge(ProjectEnrichmentTestLayer, WorkspacePaths.layer)),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  Effect.flatMap(VcsProcess.VcsProcess, (process) =>
    process.run({ operation: "thread-handoff.test", command, args, cwd }),
  );

const git = (args: ReadonlyArray<string>, cwd: string) => run("git", args, cwd);

const write = (dir: string, relative: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(dir, relative);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, contents);
  });

const tempDir = (prefix: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix }));

const configureRepo = (cwd: string) =>
  Effect.gen(function* () {
    yield* git(["config", "user.email", "test@test.com"], cwd);
    yield* git(["config", "user.name", "Test"], cwd);
    yield* git(["config", "commit.gpgsign", "false"], cwd);
  });

/** The receiving environment's repository: branch `main` at one commit. */
const makeReceiverRepo = Effect.gen(function* () {
  const cwd = yield* tempDir("t3-handoff-receiver-");
  yield* git(["init", "-b", "main"], cwd);
  yield* configureRepo(cwd);
  yield* write(cwd, "a.txt", "base\n");
  yield* git(["add", "a.txt"], cwd);
  yield* git(["commit", "-m", "base"], cwd);
  return cwd;
});

/**
 * A sender clone that adds one commit on `branch`, then the bundle carrying it.
 * The bundle is staged under the handoff directory exactly as a real transfer
 * would leave it, so `receive` reads the same bytes it does in production.
 */
const stageIncoming = (input: {
  readonly receiverRepo: string;
  readonly handoffId: ThreadHandoffId;
  readonly branch: string;
  /** Written verbatim as the tracked-patch part; null stages no patch. */
  readonly patch: string | null;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const handoffGit = yield* ThreadHandoffGit.ThreadHandoffGit;

    const sender = path.join(yield* tempDir("t3-handoff-sender-"), "clone");
    yield* git(["clone", input.receiverRepo, sender], ".");
    yield* configureRepo(sender);
    yield* git(["checkout", "-B", input.branch], sender);
    yield* write(sender, "a.txt", "advanced\n");
    yield* git(["commit", "-am", "advance"], sender);
    const headSha = yield* handoffGit.resolveHead({ cwd: sender });

    const dir = path.join(config.handoffsDir, input.handoffId);
    yield* fs.makeDirectory(dir, { recursive: true });

    const parts: Array<OrchestrationV2HandoffPart> = [];
    const declare = (kind: OrchestrationV2HandoffPartKind) =>
      Effect.gen(function* () {
        const bytes = yield* fs.readFile(path.join(dir, ThreadHandoffService.partFileName(kind)));
        parts.push({ kind, digest: ThreadHandoffService.sha256(bytes), byteLength: bytes.length });
      });

    yield* handoffGit.createBundle({
      cwd: sender,
      outputPath: path.join(dir, ThreadHandoffService.partFileName("git-bundle")),
      refs: [`refs/heads/${input.branch}`],
      excludeTips: [],
    });
    yield* declare("git-bundle");

    if (input.patch !== null) {
      yield* fs.writeFileString(
        path.join(dir, ThreadHandoffService.partFileName("tracked-patch")),
        input.patch,
      );
      yield* declare("tracked-patch");
    }

    return { headSha, parts, dir };
  });

/** A diff whose context matches nothing on either side, so `git apply` refuses it. */
const unappliablePatch = `diff --git a/a.txt b/a.txt
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-nothing here ever looked like this
+and it never will
`;

const bundleFor = (input: {
  readonly handoffId: ThreadHandoffId;
  readonly branch: string;
  readonly headSha: string;
  readonly parts: ReadonlyArray<OrchestrationV2HandoffPart>;
  readonly worktree: boolean;
}): OrchestrationV2HandoffBundleV1Type => ({
  version: 1,
  handoffId: input.handoffId,
  origin: {
    environmentId: EnvironmentId.make("environment-sender"),
    threadId: ThreadId.make(`thread:origin-${input.handoffId}`),
    serverVersion: "0.0.0-test",
    label: "sender",
  },
  repository: {
    canonicalKey: "github.com/t3/handoff",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/t3/handoff.git",
    },
  },
  workspace: {
    branch: input.branch,
    headSha: input.headSha,
    strategy: input.worktree
      ? { type: "existing_worktree", worktreePath: "/sender/worktree", branch: input.branch }
      : { type: "root", branch: input.branch },
  },
  conversation: { items: [], coveredRunOrdinals: [] },
  provider: {
    driverKind: driver,
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
  },
  thread: { title: "Handed off thread" },
  terminals: [],
  lineage: { previousHandoffId: null, hopCount: 1 },
  parts: input.parts,
});

const registerProject = (workspaceRoot: string) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const projectId = ProjectId.make(`project:${workspaceRoot.replaceAll("/", "-")}`);
    yield* projects.create({
      commandId: CommandId.make(`handoff-test:${projectId}`),
      projectId,
      title: "Handoff test project",
      workspaceRoot,
    });
    return projectId;
  });

const hopState = (handoffId: ThreadHandoffId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly state: string;
      readonly thread_id: string;
      readonly stash_ref: string | null;
      readonly root_stash_ref: string | null;
    }>`
      SELECT state, thread_id, stash_ref, root_stash_ref
      FROM orchestration_v2_thread_handoffs WHERE handoff_id = ${handoffId}
    `;
    return rows[0] ?? null;
  });

it.layer(HandoffLayer)("ThreadHandoffService receive against real repositories", (it) => {
  describe("a failed apply", () => {
    it.effect("puts the branch back on its pre-hop tip and fails the hop", () =>
      Effect.gen(function* () {
        const handoffGit = yield* ThreadHandoffGit.ThreadHandoffGit;
        const service = yield* ThreadHandoffService.ThreadHandoffService;
        const receiverRepo = yield* makeReceiverRepo;
        const projectId = yield* registerProject(receiverRepo);
        const beforeTip = yield* handoffGit.resolveTip({ cwd: receiverRepo, branch: "main" });
        const handoffId = ThreadHandoffId.make("handoff-apply-fails");

        const staged = yield* stageIncoming({
          receiverRepo,
          handoffId,
          branch: "main",
          patch: unappliablePatch,
        });
        const error = yield* Effect.flip(
          service.receive({
            bundle: bundleFor({ ...staged, handoffId, branch: "main", worktree: false }),
            projectId,
            cloneWorkspaceRoot: null,
            returningThreadId: null,
          }),
        );

        assert.strictEqual(error.reason, "apply_failed");
        // Reset off the pre-hop tag: the branch is exactly where it was.
        assert.strictEqual(
          yield* handoffGit.resolveTip({ cwd: receiverRepo, branch: "main" }),
          beforeTip,
        );
        assert.strictEqual((yield* hopState(handoffId))?.state, "failed");
      }),
    );

    it.effect("removes the worktree it created and everything it extracted", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const handoffGit = yield* ThreadHandoffGit.ThreadHandoffGit;
        const service = yield* ThreadHandoffService.ThreadHandoffService;
        const receiverRepo = yield* makeReceiverRepo;
        const projectId = yield* registerProject(receiverRepo);
        const handoffId = ThreadHandoffId.make("handoff-worktree-rollback");

        const staged = yield* stageIncoming({
          receiverRepo,
          handoffId,
          // A branch this environment does not have, so the hop has to add a
          // worktree rather than reuse one.
          branch: "feat/incoming",
          patch: unappliablePatch,
        });
        const error = yield* Effect.flip(
          service.receive({
            bundle: bundleFor({
              ...staged,
              handoffId,
              branch: "feat/incoming",
              worktree: true,
            }),
            projectId,
            cloneWorkspaceRoot: null,
            returningThreadId: null,
          }),
        );

        assert.strictEqual(error.reason, "apply_failed");
        const config = yield* ServerConfig;
        const worktrees = yield* fs
          .readDirectory(config.worktreesDir)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        assert.deepStrictEqual([...worktrees], []);
        assert.isFalse(
          yield* handoffGit.isBranchCheckedOut({ cwd: receiverRepo, branch: "feat/incoming" }),
        );
        assert.strictEqual((yield* hopState(handoffId))?.state, "failed");
      }),
    );

    it.effect("leaves the repository root alone when the thread lives in a worktree", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const handoffGit = yield* ThreadHandoffGit.ThreadHandoffGit;
        const service = yield* ThreadHandoffService.ThreadHandoffService;
        const receiverRepo = yield* makeReceiverRepo;
        // The thread's branch exists but nothing has it checked out; the root
        // is on an unrelated branch with its own committed and uncommitted work.
        yield* git(["branch", "feat/incoming"], receiverRepo);
        const branchTipBefore = yield* handoffGit.resolveTip({
          cwd: receiverRepo,
          branch: "feat/incoming",
        });
        yield* git(["checkout", "-b", "other"], receiverRepo);
        yield* write(receiverRepo, "a.txt", "other work\n");
        yield* git(["commit", "-am", "other work"], receiverRepo);
        const otherTip = yield* handoffGit.resolveTip({ cwd: receiverRepo, branch: "other" });
        yield* write(receiverRepo, "a.txt", "other work, mid-edit\n");

        const projectId = yield* registerProject(receiverRepo);
        const handoffId = ThreadHandoffId.make("handoff-worktree-root-untouched");
        const staged = yield* stageIncoming({
          receiverRepo,
          handoffId,
          branch: "feat/incoming",
          patch: unappliablePatch,
        });

        const error = yield* Effect.flip(
          service.receive({
            bundle: bundleFor({ ...staged, handoffId, branch: "feat/incoming", worktree: true }),
            projectId,
            cloneWorkspaceRoot: null,
            returningThreadId: null,
          }),
        );

        assert.strictEqual(error.reason, "apply_failed");
        // The root never moved: same branch, same commit, same mid-edit.
        assert.strictEqual(
          (yield* git(["rev-parse", "--abbrev-ref", "HEAD"], receiverRepo)).stdout.trim(),
          "other",
        );
        assert.strictEqual(
          yield* handoffGit.resolveTip({ cwd: receiverRepo, branch: "other" }),
          otherTip,
        );
        assert.strictEqual(
          yield* fs.readFileString(path.join(receiverRepo, "a.txt")),
          "other work, mid-edit\n",
        );
        // The thread's branch — the one the hop did move — is back where it was.
        assert.strictEqual(
          yield* handoffGit.resolveTip({ cwd: receiverRepo, branch: "feat/incoming" }),
          branchTipBefore,
        );
        assert.strictEqual((yield* hopState(handoffId))?.state, "failed");
      }),
    );
  });

  describe("a clone from the bundle that fails", () => {
    it.effect("removes the partial clone so a retry can succeed", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projects = yield* ProjectService.ProjectService;
        const service = yield* ThreadHandoffService.ThreadHandoffService;
        const receiverRepo = yield* makeReceiverRepo;
        const handoffId = ThreadHandoffId.make("handoff-clone-cleanup");
        const staged = yield* stageIncoming({
          receiverRepo,
          handoffId,
          branch: "main",
          patch: null,
        });

        // Another project already claims the clone target, so registering the
        // cloned project fails — after the clone directory has been written.
        const cloneRoot = path.join(yield* tempDir("t3-handoff-clone-"), "clone");
        yield* fs.makeDirectory(cloneRoot, { recursive: true });
        const squatter = yield* registerProject(cloneRoot);
        yield* fs.remove(cloneRoot, { recursive: true });

        const receiveInput = {
          bundle: bundleFor({ ...staged, handoffId, branch: "main", worktree: false }),
          projectId: null,
          cloneWorkspaceRoot: cloneRoot,
          returningThreadId: null,
        };
        const error = yield* Effect.flip(service.receive(receiveInput));

        assert.strictEqual(error.reason, "store_failed");
        assert.isFalse(yield* fs.exists(cloneRoot));
        assert.strictEqual((yield* hopState(handoffId))?.state, "failed");

        // With the conflict gone the same transfer lands, because nothing is
        // occupying the clone target any more.
        yield* projects.delete({
          commandId: CommandId.make("handoff-test:clone-cleanup:delete"),
          projectId: squatter,
        });
        const applied = yield* service.receive(receiveInput);

        assert.isTrue(yield* fs.exists(path.join(cloneRoot, ".git")));
        assert.strictEqual((yield* hopState(handoffId))?.state, "arrived");
        assert.strictEqual(applied.projectId.startsWith("project:"), true);
      }),
    );
  });

  describe("a successful advance into a dirty checkout", () => {
    it.effect("lands the hop and gives the receiver its changes back", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const handoffGit = yield* ThreadHandoffGit.ThreadHandoffGit;
        const service = yield* ThreadHandoffService.ThreadHandoffService;
        const receiverRepo = yield* makeReceiverRepo;
        const projectId = yield* registerProject(receiverRepo);
        const handoffId = ThreadHandoffId.make("handoff-dirty-advance");
        const staged = yield* stageIncoming({
          receiverRepo,
          handoffId,
          branch: "main",
          patch: null,
        });
        // The receiver is mid-edit when the hop arrives — in a file the
        // incoming commit does not touch, so the restore applies cleanly.
        yield* write(receiverRepo, "receiver-local.txt", "receiver work\n");

        const applied = yield* service.receive({
          bundle: bundleFor({ ...staged, handoffId, branch: "main", worktree: false }),
          projectId,
          cloneWorkspaceRoot: null,
          returningThreadId: null,
        });

        assert.strictEqual(applied.classification, "advance");
        assert.strictEqual(
          yield* handoffGit.resolveTip({ cwd: receiverRepo, branch: "main" }),
          staged.headSha,
        );
        const row = yield* hopState(handoffId);
        assert.strictEqual(row?.state, "arrived");

        // The pointer moved, and the receiver's own mid-edit came back out of
        // the stash: the hop must never cost the receiver uncommitted work.
        assert.strictEqual(
          yield* fs.readFileString(path.join(receiverRepo, "receiver-local.txt")),
          "receiver work\n",
        );
        assert.isNull(row?.root_stash_ref);
      }),
    );
  });

  describe("a retried first arrival", () => {
    it.effect("lands on the thread id the failed attempt already recorded", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* ThreadHandoffService.ThreadHandoffService;
        const receiverRepo = yield* makeReceiverRepo;
        const projectId = yield* registerProject(receiverRepo);
        const handoffId = ThreadHandoffId.make("handoff-retried");

        const staged = yield* stageIncoming({
          receiverRepo,
          handoffId,
          branch: "main",
          patch: unappliablePatch,
        });
        yield* Effect.flip(
          service.receive({
            bundle: bundleFor({ ...staged, handoffId, branch: "main", worktree: false }),
            projectId,
            cloneWorkspaceRoot: null,
            returningThreadId: null,
          }),
        );
        const failedRow = yield* hopState(handoffId);
        assert.strictEqual(failedRow?.state, "failed");

        // The retry carries the same handoff id with a payload that applies.
        yield* fs.remove(path.join(staged.dir, ThreadHandoffService.partFileName("tracked-patch")));
        const retried = yield* service.receive({
          bundle: bundleFor({
            handoffId,
            branch: "main",
            headSha: staged.headSha,
            parts: staged.parts.filter((part) => part.kind !== "tracked-patch"),
            worktree: false,
          }),
          projectId,
          cloneWorkspaceRoot: null,
          returningThreadId: null,
        });

        assert.strictEqual(retried.threadId, failedRow?.thread_id);
        const landed = yield* hopState(handoffId);
        assert.strictEqual(landed?.state, "arrived");
        assert.strictEqual(landed?.thread_id, failedRow?.thread_id);
        const projection = yield* (yield* ProjectionStoreV2).getThreadProjection(retried.threadId);
        assert.strictEqual(projection.thread.handoff?.presence, "here");
      }),
    );
  });

  describe("recoverInterrupted", () => {
    it.effect("pops each interrupted stash against the checkout it was taken in", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sql = yield* SqlClient.SqlClient;
        const handoffGit = yield* ThreadHandoffGit.ThreadHandoffGit;
        const service = yield* ThreadHandoffService.ThreadHandoffService;
        const rootCwd = yield* makeReceiverRepo;
        const applyCwd = path.join(yield* tempDir("t3-handoff-interrupted-"), "checkout");
        const head = yield* handoffGit.resolveHead({ cwd: rootCwd });
        yield* handoffGit.addWorktree({ cwd: rootCwd, path: applyCwd, commit: head });

        // Both checkouts were dirty and both were stashed, the way an apply
        // that reaches a worktree leaves them.
        yield* write(rootCwd, "a.txt", "root work\n");
        yield* write(applyCwd, "a.txt", "worktree work\n");
        const rootStashRef = yield* handoffGit.stashWorktree({ cwd: rootCwd, label: "root" });
        const worktreeStashRef = yield* handoffGit.stashWorktree({
          cwd: applyCwd,
          label: "worktree",
        });
        assert.isNotNull(rootStashRef);
        assert.isNotNull(worktreeStashRef);

        const handoffId = ThreadHandoffId.make("handoff-interrupted");
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO orchestration_v2_thread_handoffs (
            handoff_id, thread_id, peer_environment_id, peer_thread_id,
            previous_handoff_id, hop_count, state, manifest_json,
            stash_ref, root_stash_ref, pre_tag, apply_cwd, root_cwd,
            created_at, updated_at
          ) VALUES (
            ${handoffId}, ${"thread:interrupted"}, ${"environment-sender"}, ${null},
            ${null}, ${1}, ${"applying"}, ${"{}"},
            ${worktreeStashRef}, ${rootStashRef}, ${null}, ${applyCwd}, ${rootCwd},
            ${now}, ${now}
          )
        `;

        assert.strictEqual(yield* service.recoverInterrupted(), 1);

        // Each stash went back to its own tree, not the other one's.
        assert.strictEqual(yield* fs.readFileString(path.join(rootCwd, "a.txt")), "root work\n");
        assert.strictEqual(
          yield* fs.readFileString(path.join(applyCwd, "a.txt")),
          "worktree work\n",
        );
        assert.strictEqual((yield* hopState(handoffId))?.state, "failed");
      }),
    );

    it.effect("removes a worktree the interrupted hop created and restores its branch", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sql = yield* SqlClient.SqlClient;
        const handoffGit = yield* ThreadHandoffGit.ThreadHandoffGit;
        const service = yield* ThreadHandoffService.ThreadHandoffService;
        const rootCwd = yield* makeReceiverRepo;
        const oldTip = yield* handoffGit.resolveHead({ cwd: rootCwd });
        // The hop moved feat/incoming forward and attached it in a worktree
        // it created, then the server died before the arrival was recorded.
        yield* git(["branch", "feat/incoming", oldTip], rootCwd);
        yield* git(["tag", "handoff-pre-created", oldTip], rootCwd);
        yield* write(rootCwd, "b.txt", "moved\n");
        yield* git(["add", "b.txt"], rootCwd);
        yield* git(["commit", "-m", "moved"], rootCwd);
        const movedTip = yield* handoffGit.resolveHead({ cwd: rootCwd });
        yield* git(["reset", "--hard", oldTip], rootCwd);
        yield* git(["branch", "-f", "feat/incoming", movedTip], rootCwd);
        const applyCwd = path.join(yield* tempDir("t3-handoff-created-"), "worktree");
        yield* handoffGit.addWorktree({ cwd: rootCwd, path: applyCwd, commit: movedTip });

        const handoffId = ThreadHandoffId.make("handoff-created-worktree");
        const now = DateTime.formatIso(yield* DateTime.now);
        const manifest = yield* Schema.encodeEffect(
          Schema.fromJsonString(OrchestrationV2HandoffBundleV1),
        )(
          bundleFor({
            handoffId,
            branch: "feat/incoming",
            headSha: movedTip,
            parts: [],
            worktree: true,
          }),
        );
        yield* sql`
          INSERT INTO orchestration_v2_thread_handoffs (
            handoff_id, thread_id, peer_environment_id, peer_thread_id,
            previous_handoff_id, hop_count, state, manifest_json,
            stash_ref, root_stash_ref, pre_tag, apply_cwd, root_cwd,
            created_worktree, created_at, updated_at
          ) VALUES (
            ${handoffId}, ${"thread:created-worktree"}, ${"environment-sender"}, ${null},
            ${null}, ${1}, ${"applying"}, ${manifest},
            ${null}, ${null}, ${"handoff-pre-created"}, ${applyCwd}, ${rootCwd},
            ${1}, ${now}, ${now}
          )
        `;

        assert.strictEqual(yield* service.recoverInterrupted(), 1);

        // The worktree is gone, so a retry can provision the same path again,
        // and the branch is back at the tip it had before the hop.
        assert.isFalse(yield* fs.exists(applyCwd));
        assert.strictEqual(
          yield* handoffGit.resolveTip({ cwd: rootCwd, branch: "feat/incoming" }),
          oldTip,
        );
        assert.strictEqual((yield* hopState(handoffId))?.state, "failed");
      }),
    );
  });

  describe("prepare", () => {
    it.effect("removes the staged handoff directory when preparing fails", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const eventSink = yield* EventSinkV2;
        const service = yield* ThreadHandoffService.ThreadHandoffService;
        // No remote, so preparing fails at the repository-identity step — after
        // the parts have already been staged.
        const receiverRepo = yield* makeReceiverRepo;
        const projectId = yield* registerProject(receiverRepo);
        const threadId = ThreadId.make("thread:prepare-cleanup");
        const now = yield* DateTime.now;
        const thread = {
          id: threadId,
          projectId,
          title: "Prepare cleanup",
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdBy: "user",
          creationSource: "server",
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        } as OrchestrationV2AppThread;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("handoff-test:prepare-cleanup:thread"),
              type: "thread.created",
              threadId,
              providerInstanceId: thread.providerInstanceId,
              occurredAt: now,
              payload: thread,
            },
          ],
        });

        const listStaged = fs
          .readDirectory(config.handoffsDir)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        const before = yield* listStaged;

        const error = yield* Effect.flip(
          service.prepare({
            threadId,
            peerEnvironmentId: EnvironmentId.make("environment-peer"),
            peerBranchTip: null,
            fullHistory: true,
            previousHandoffId: null,
            hopCount: 0,
          }),
        );

        assert.strictEqual(error.reason, "repository_mismatch");
        // The bundle part was staged before the failing step, and the whole
        // directory is gone again: nothing is left with no id pointing at it.
        assert.deepStrictEqual([...(yield* listStaged)].sort(), [...before].sort());
      }),
    );
  });
});
