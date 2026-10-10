import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import {
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type TerminalSummary,
} from "@t3tools/contracts";

import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as WorktreeLifecycle from "./WorktreeLifecycle.ts";
import * as WorktreeRevivalService from "./WorktreeRevivalService.ts";
import * as WorktreeService from "./WorktreeService.ts";
import {
  addWorktree,
  commitIn,
  initializeRepository,
  makeHarness,
  makeProject,
  projectId,
} from "./WorktreeService.testkit.ts";
import { makeThreadShell } from "./worktreeThreadState.testkit.ts";

const linkedThread = (
  worktreePath: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell =>
  makeThreadShell({
    id: ThreadId.make(`thread-${worktreePath}`),
    projectId,
    worktreePath,
    branch: `feature/${worktreePath.split(/[\\/]/).at(-1)}`,
    ...overrides,
  });

const runningTerminal = (cwd: string): TerminalSummary => ({
  threadId: "thread-terminal",
  terminalId: "terminal-1",
  cwd,
  worktreePath: null,
  status: "running",
  pid: 1,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: false,
  label: "shell",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const insertLiveSession = Effect.fn("WorktreeServiceTest.insertLiveSession")(function* (
  cwd: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_sessions
      (provider_session_id, thread_id, provider, status, model, updated_at, payload_json)
    VALUES
      ('session-1', 'thread-session', 'codex', 'ready', NULL, '2026-01-01T00:00:00.000Z',
       json_object('cwd', ${cwd}))
  `;
});

const removeManually = Effect.fn("WorktreeServiceTest.removeManually")(function* (
  worktreePath: string,
  options: { readonly allowIgnoredFiles?: boolean } = {},
) {
  const worktrees = yield* WorktreeService.WorktreeService;
  const result = yield* worktrees.pruneWorktrees({ projectId, paths: [worktreePath], ...options });
  return result.skipped[0]?.reason ?? "removed";
});

it.effect("keeps a worktree that is in use, has unsaved work, or has an open thread", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repositoryRoot = yield* initializeRepository();
    state.projects = [makeProject(repositoryRoot)];
    const settled = { settledOverride: "settled" } as const;

    const running = yield* addWorktree(repositoryRoot, "running");
    state.threads = [
      linkedThread(running, { ...settled, status: "running", activeRunId: RunId.make("run-1") }),
    ];
    assert.equal(yield* removeManually(running), "running");

    // A settled thread whose message has not started a run yet is still in use.
    const queued = yield* addWorktree(repositoryRoot, "queued");
    state.threads = [
      linkedThread(queued, { ...settled, latestUserMessageAt: DateTime.makeUnsafe(0) }),
    ];
    assert.equal(yield* removeManually(queued), "running");

    const open = yield* addWorktree(repositoryRoot, "open");
    state.threads = [linkedThread(open)];
    assert.equal(yield* removeManually(open), "open_thread");
    state.threads = [];

    const dirty = yield* addWorktree(repositoryRoot, "dirty");
    yield* fs.writeFileString(path.join(dirty, "notes.txt"), "draft\n");
    assert.equal(yield* removeManually(dirty), "dirty");

    const unpushed = yield* addWorktree(repositoryRoot, "unpushed");
    yield* commitIn(unpushed);
    assert.equal(yield* removeManually(unpushed), "unpushed");

    const terminal = yield* addWorktree(repositoryRoot, "terminal");
    yield* state.publishTerminals({
      type: "snapshot",
      terminals: [runningTerminal(path.join(terminal, "src"))],
    });
    assert.equal(yield* removeManually(terminal), "terminal");
    yield* state.publishTerminals({ type: "snapshot", terminals: [] });

    const session = yield* addWorktree(repositoryRoot, "session");
    yield* insertLiveSession(session);
    assert.equal(yield* removeManually(session), "session");

    for (const kept of [running, queued, open, dirty, unpushed, terminal, session]) {
      assert.isTrue(yield* fs.exists(kept), kept);
    }
  }).pipe(Effect.provide(layer));
});

it.effect("removes a clean worktree by hand and keeps its branch", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const lifecycle = yield* WorktreeLifecycle.WorktreeLifecycle;
    const repositoryRoot = yield* initializeRepository();
    state.projects = [makeProject(repositoryRoot)];
    const worktreePath = yield* addWorktree(repositoryRoot, "clean");
    state.threads = [linkedThread(worktreePath, { settledOverride: "settled" })];

    const result = yield* (yield* WorktreeService.WorktreeService).pruneWorktrees({
      projectId,
      paths: [worktreePath],
    });

    assert.deepEqual(result, {
      removed: [{ path: worktreePath, workspaceRoot: repositoryRoot }],
      skipped: [],
    });
    assert.isFalse(yield* fs.exists(worktreePath));
    assert.equal(yield* lifecycle.revision, 1);
    const branch = yield* git.execute({
      operation: "WorktreeServiceTest.branchKept",
      cwd: repositoryRoot,
      args: ["show-ref", "--verify", "--quiet", "refs/heads/feature/clean"],
      allowNonZeroExit: true,
    });
    assert.equal(branch.exitCode, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("finishes a removal whose request is cancelled while Git is deleting", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lifecycle = yield* WorktreeLifecycle.WorktreeLifecycle;
    const repositoryRoot = yield* initializeRepository();
    state.projects = [makeProject(repositoryRoot)];
    const worktreePath = yield* addWorktree(repositoryRoot, "cancelled");
    const removalStarted = yield* Deferred.make<void>();
    const releaseRemoval = yield* Deferred.make<void>();
    state.beforeGitRemove = Deferred.succeed(removalStarted, undefined).pipe(
      Effect.andThen(Deferred.await(releaseRemoval)),
    );

    const request = yield* (yield* WorktreeService.WorktreeService)
      .pruneWorktrees({ projectId, paths: [worktreePath] })
      .pipe(Effect.forkChild);
    yield* Deferred.await(removalStarted);
    const cancellation = yield* Fiber.interrupt(request).pipe(Effect.forkChild);
    yield* Deferred.succeed(releaseRemoval, undefined);
    yield* Fiber.join(cancellation);

    assert.isFalse(yield* fs.exists(worktreePath));
    assert.equal(yield* lifecycle.revision, 1);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps a checkout when its linked thread records a different branch", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repositoryRoot = yield* initializeRepository();
    state.projects = [makeProject(repositoryRoot)];
    const worktreePath = yield* addWorktree(repositoryRoot, "switched");
    state.threads = [linkedThread(worktreePath, { branch: "main", settledOverride: "settled" })];
    const worktrees = yield* WorktreeService.WorktreeService;
    const [listed] = (yield* worktrees.listWorktrees({})).worktrees;
    assert.deepInclude(listed, { safeToPrune: false, pruneBlockers: ["unrestorable_thread"] });
    assert.equal(yield* removeManually(worktreePath), "unrestorable_thread");
    assert.isTrue(yield* fs.exists(worktreePath));
    state.threads = [linkedThread(worktreePath, { settledOverride: "settled" })];
    assert.equal(yield* removeManually(worktreePath), "removed");
  }).pipe(Effect.provide(layer));
});

it.effect("deletes ignored files only when the request opts in", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repositoryRoot = yield* initializeRepository();
    state.projects = [makeProject(repositoryRoot)];

    const withSecrets = yield* addWorktree(repositoryRoot, "secrets");
    yield* fs.writeFileString(path.join(withSecrets, ".env"), "TOKEN=1\n");
    assert.equal(yield* removeManually(withSecrets), "ignored_files");
    assert.equal(yield* removeManually(withSecrets, { allowIgnoredFiles: false }), "ignored_files");
    assert.isTrue(yield* fs.exists(path.join(withSecrets, ".env")));
    assert.equal(yield* removeManually(withSecrets, { allowIgnoredFiles: true }), "removed");
    assert.isFalse(yield* fs.exists(withSecrets));

    // Dependency installs are reproducible and never need the opt-in.
    const withDependencies = yield* addWorktree(repositoryRoot, "dependencies");
    yield* fs.makeDirectory(path.join(withDependencies, "node_modules", "pkg"), {
      recursive: true,
    });
    yield* fs.writeFileString(path.join(withDependencies, "node_modules", "pkg", "index.js"), "");
    assert.equal(yield* removeManually(withDependencies), "removed");
  }).pipe(Effect.provide(layer));
});

it.effect("reads and removes a worktree with hundreds of ignored files", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repositoryRoot = yield* initializeRepository();
    state.projects = [makeProject(repositoryRoot)];
    // A file pattern lists every match, unlike an ignored directory.
    yield* fs.writeFileString(path.join(repositoryRoot, ".git", "info", "exclude"), "*.log\n");
    const worktreePath = yield* addWorktree(repositoryRoot, "many-logs");
    const logCount = 400;
    yield* Effect.forEach(
      Array.from({ length: logCount }, (_, index) => index),
      (index) =>
        fs.writeFileString(
          path.join(worktreePath, `${String(index).padStart(4, "0")}-${"x".repeat(200)}.log`),
          "",
        ),
      { concurrency: 16 },
    );
    const worktrees = yield* WorktreeService.WorktreeService;

    const [listed] = (yield* worktrees.listWorktrees({})).worktrees;
    assert.deepInclude(listed, {
      path: worktreePath,
      ignoredFileCount: logCount,
      safeToPrune: true,
      pruneBlockers: [],
    });
    // The row carries a sample for the confirmation, not every path.
    assert.equal(listed?.ignoredFiles.length, 5);

    assert.equal(yield* removeManually(worktreePath), "ignored_files");
    assert.equal(yield* removeManually(worktreePath, { allowIgnoredFiles: true }), "removed");
    assert.isFalse(yield* fs.exists(worktreePath));
  }).pipe(Effect.provide(layer));
});

it.effect("refuses the legacy forced removal of a worktree with changes", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repositoryRoot = yield* initializeRepository();
    state.projects = [makeProject(repositoryRoot)];
    const dirty = yield* addWorktree(repositoryRoot, "legacy-dirty");
    yield* fs.writeFileString(path.join(dirty, "notes.txt"), "draft\n");
    const withSecrets = yield* addWorktree(repositoryRoot, "legacy-secrets");
    yield* fs.writeFileString(path.join(withSecrets, ".env"), "TOKEN=1\n");
    const worktrees = yield* WorktreeService.WorktreeService;

    const dirtyError = yield* worktrees
      .removeWorktree({ cwd: repositoryRoot, path: dirty, force: true })
      .pipe(Effect.flip);
    const secretsError = yield* worktrees
      .removeWorktree({ cwd: repositoryRoot, path: withSecrets, force: true })
      .pipe(Effect.flip);

    assert.equal(dirtyError.reason, "dirty");
    assert.equal(secretsError.reason, "ignored_files");
    assert.isTrue(yield* fs.exists(path.join(dirty, "notes.txt")));
    assert.isTrue(yield* fs.exists(path.join(withSecrets, ".env")));
  }).pipe(Effect.provide(layer));
});

it.effect(
  "keeps a checkout with initialized submodules, which Git only removes when forced",
  () => {
    const { state, layer } = makeHarness();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const worktrees = yield* WorktreeService.WorktreeService;
      const run = (cwd: string, args: ReadonlyArray<string>) =>
        git.execute({
          operation: "WorktreeServiceTest.submodules",
          cwd,
          args: ["-c", "protocol.file.allow=always", "-c", "user.name=T3 Test", ...args],
        });
      const library = yield* initializeRepository();
      const repositoryRoot = yield* initializeRepository();
      state.projects = [makeProject(repositoryRoot)];
      yield* run(repositoryRoot, ["submodule", "add", library, "lib"]);
      yield* run(repositoryRoot, ["commit", "-m", "add submodule"]);
      yield* run(repositoryRoot, ["update-ref", "refs/remotes/upstream/main", "refs/heads/main"]);
      const headSha = (yield* git.resolveCommit({ cwd: repositoryRoot, revision: "HEAD" }))
        .commitSha;

      // Clean, but its submodule holds a commit no remote has.
      const initialized = yield* addWorktree(repositoryRoot, "initialized");
      yield* run(initialized, ["submodule", "update", "--init"]);
      const submodule = path.join(initialized, "lib");
      yield* run(submodule, ["checkout", "-b", "unpublished"]);
      yield* run(submodule, [
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "x",
      ]);
      yield* run(submodule, ["checkout", "--detach", "HEAD~1"]);
      // Checked out by hand, so this worktree's Git directory has no submodule repository.
      const cloned = yield* addWorktree(repositoryRoot, "cloned");
      yield* run(repositoryRoot, ["clone", library, path.join(cloned, "lib")]);
      const uninitialized = yield* addWorktree(repositoryRoot, "uninitialized");
      const late = yield* addWorktree(repositoryRoot, "late");

      const listed = (yield* worktrees.listWorktrees({})).worktrees.find(
        (worktree) => worktree.path === initialized,
      );
      assert.deepInclude(listed, {
        dirty: false,
        safeToPrune: false,
        pruneBlockers: ["submodules"],
      });
      assert.equal(yield* removeManually(initialized), "submodules");
      assert.equal(yield* removeManually(cloned), "submodules");
      assert.deepEqual(
        yield* worktrees.removeIfSafe({
          path: initialized,
          workspaceRoot: repositoryRoot,
          intent: "policy",
          expected: { branch: "feature/initialized", headSha },
          recheck: Effect.succeed(true),
        }),
        { outcome: "skipped", reason: "submodules" },
      );
      assert.isTrue(yield* fs.exists(cloned));
      yield* run(submodule, ["rev-parse", "--verify", "refs/heads/unpublished"]);
      // Deinitializing keeps the repository and its unpublished branch in Git metadata.
      yield* run(initialized, ["submodule", "deinit", "--force", "lib"]);
      assert.isFalse(yield* fs.exists(path.join(submodule, ".git")));
      assert.equal(yield* removeManually(initialized), "submodules");
      // Initialized after the first inspection found none.
      assert.deepEqual(
        yield* worktrees.removeIfSafe({
          path: late,
          workspaceRoot: repositoryRoot,
          intent: "policy",
          expected: { branch: "feature/late", headSha },
          recheck: run(late, ["submodule", "update", "--init"]).pipe(Effect.as(true), Effect.orDie),
        }),
        { outcome: "skipped", reason: "submodules" },
      );
      assert.isTrue(yield* fs.exists(path.join(late, "lib", ".git")));

      assert.equal(yield* removeManually(uninitialized), "removed");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("refreshes inventory after cleanup changes a checkout whose removal fails", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const worktrees = yield* WorktreeService.WorktreeService;
    const repositoryRoot = yield* initializeRepository();
    state.projects = [makeProject(repositoryRoot)];
    const worktreePath = yield* addWorktree(repositoryRoot, "partial-cleanup");
    yield* fs.writeFileString(path.join(worktreePath, ".env"), "local data");
    yield* fs.writeFileString(path.join(worktreePath, "notes.txt"), "untracked data");
    const before = yield* worktrees.listWorktrees({});
    const headSha = (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha;
    // An external writer changes tracked data after clean succeeds. Git then refuses removal.
    state.beforeGitRemove = fs
      .writeFileString(path.join(worktreePath, "README.md"), "new work")
      .pipe(Effect.orDie);
    const result = yield* worktrees.removeIfSafe({
      path: worktreePath,
      workspaceRoot: repositoryRoot,
      intent: "policy",
      keepWhen: "tracked-changes",
      expected: { branch: "feature/partial-cleanup", headSha },
      recheck: Effect.succeed(true),
    });
    assert.deepInclude(result, { outcome: "skipped", reason: "remove_failed" });
    assert.isTrue(yield* fs.exists(worktreePath));
    assert.isFalse(yield* fs.exists(path.join(worktreePath, ".env")));
    assert.isFalse(yield* fs.exists(path.join(worktreePath, "notes.txt")));
    const after = yield* worktrees.listWorktrees({});
    assert.isAbove(after.revision, before.revision);
    assert.deepInclude(
      after.worktrees.find((entry) => entry.path === worktreePath),
      {
        dirtyFileCount: 1,
        ignoredFileCount: 0,
        safeToPrune: false,
      },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("removes a detached checkout only once its commit is on the default branch", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repositoryRoot = yield* initializeRepository();
    state.projects = [makeProject(repositoryRoot)];

    const ahead = yield* addWorktree(repositoryRoot, "detached-ahead", { detached: true });
    yield* commitIn(ahead);
    assert.equal(yield* removeManually(ahead), "unpushed");

    // Revival restores a thread's branch, so its detached commit would not return.
    const linked = yield* addWorktree(repositoryRoot, "detached-linked", { detached: true });
    state.threads = [linkedThread(linked, { settledOverride: "settled" })];
    assert.equal(yield* removeManually(linked), "unrestorable_thread");

    // A thread that recorded no branch cannot be restored on a named checkout either.
    const branchless = yield* addWorktree(repositoryRoot, "branchless-thread");
    state.threads = [linkedThread(branchless, { settledOverride: "settled", branch: null })];
    assert.equal(yield* removeManually(branchless), "unrestorable_thread");
    assert.isTrue(yield* fs.exists(branchless));
    state.threads = [];

    const merged = yield* addWorktree(repositoryRoot, "detached-merged", { detached: true });
    assert.equal(yield* removeManually(merged), "removed");
  }).pipe(Effect.provide(layer));
});

it.effect("never removes a checkout outside the managed directory or a project root", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repositoryRoot = yield* initializeRepository();
    const external = path.join(
      yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-worktree-external-" })),
      "checkout",
    );
    yield* git.execute({
      operation: "WorktreeServiceTest.externalWorktree",
      cwd: repositoryRoot,
      args: ["worktree", "add", "-b", "feature/external", external, "main"],
    });
    const asProject = yield* addWorktree(repositoryRoot, "registered-project");
    state.projects = [
      makeProject(repositoryRoot),
      { ...makeProject(asProject), id: ProjectId.make("project-in-worktree") },
    ];

    assert.equal(yield* removeManually(external), "protected_path");
    assert.equal(yield* removeManually(asProject), "protected_path");
    assert.equal(yield* removeManually(repositoryRoot), "protected_path");
    assert.isTrue(yield* fs.exists(external));
    assert.isTrue(yield* fs.exists(asProject));
  }).pipe(Effect.provide(layer));
});

it.effect("counts threads of every project that shares the repository", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repositoryRoot = yield* initializeRepository();
    const nestedRoot = path.join(repositoryRoot, "packages");
    yield* fs.makeDirectory(nestedRoot);
    const nestedProjectId = ProjectId.make("project-nested");
    state.projects = [
      makeProject(repositoryRoot),
      { ...makeProject(nestedRoot), id: nestedProjectId, title: "Nested" },
    ];
    const worktreePath = yield* addWorktree(repositoryRoot, "shared");
    state.threads = [linkedThread(worktreePath, { projectId: nestedProjectId })];

    // Requested through the other project: its sibling's open thread still counts.
    assert.equal(yield* removeManually(worktreePath), "open_thread");
    const { worktrees } = yield* (yield* WorktreeService.WorktreeService).listWorktrees({
      projectId,
    });
    assert.deepEqual(
      worktrees.map((worktree) => worktree.projects.map((project) => project.projectId)),
      [[projectId, nestedProjectId]],
    );
    assert.deepEqual(worktrees[0]?.pruneBlockers, ["open_thread"]);
  }).pipe(Effect.provide(layer));
});

it.effect("lets cleanup remove an idle open thread's clean worktree with unpushed commits", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repositoryRoot = yield* initializeRepository();
    state.projects = [makeProject(repositoryRoot)];
    const worktreePath = yield* addWorktree(repositoryRoot, "policy");
    const headSha = yield* commitIn(worktreePath);
    state.threads = [linkedThread(worktreePath)];
    const worktrees = yield* WorktreeService.WorktreeService;
    const policy = {
      path: worktreePath,
      workspaceRoot: repositoryRoot,
      intent: "policy",
      expected: { branch: "feature/policy", headSha },
    } as const;

    assert.deepEqual(yield* worktrees.removeIfSafe({ ...policy, recheck: Effect.succeed(false) }), {
      outcome: "skipped",
      reason: "policy_changed",
    });
    assert.deepEqual(
      yield* worktrees.removeIfSafe({
        ...policy,
        expected: { branch: "feature/policy", headSha: "0".repeat(40) },
        recheck: Effect.succeed(true),
      }),
      { outcome: "skipped", reason: "changed" },
    );
    assert.isTrue(yield* fs.exists(worktreePath));

    assert.deepEqual(yield* worktrees.removeIfSafe({ ...policy, recheck: Effect.succeed(true) }), {
      outcome: "removed",
    });
    assert.isFalse(yield* fs.exists(worktreePath));
  }).pipe(Effect.provide(layer));
});

it.effect("keeps a checkout that is switched or committed to during the final checks", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repositoryRoot = yield* initializeRepository();
    state.projects = [makeProject(repositoryRoot)];
    const worktrees = yield* WorktreeService.WorktreeService;
    // The policy recheck is the last awaited step before the final inspection,
    // so a change made inside it lands after every earlier check has passed.
    const removeWhile = Effect.fn(function* (name: string, change: ReadonlyArray<string>) {
      const worktreePath = yield* addWorktree(repositoryRoot, name);
      const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
      const outcome = yield* worktrees.removeIfSafe({
        path: worktreePath,
        workspaceRoot: repositoryRoot,
        intent: "policy",
        expected: { branch: `feature/${name}`, headSha: head.commitSha },
        recheck: git
          .execute({ operation: "WorktreeServiceTest.lateChange", cwd: worktreePath, args: change })
          .pipe(Effect.as(true), Effect.orDie),
      });
      return { outcome, kept: yield* fs.exists(worktreePath) };
    });

    // Same commit, another branch.
    assert.deepEqual(yield* removeWhile("late-switch", ["checkout", "-b", "feature/elsewhere"]), {
      outcome: { outcome: "skipped", reason: "changed" },
      kept: true,
    });
    // Same branch, a new commit.
    assert.deepEqual(
      yield* removeWhile("late-commit", ["commit", "--allow-empty", "-m", "late work"]),
      { outcome: { outcome: "skipped", reason: "changed" }, kept: true },
    );
  }).pipe(Effect.provide(layer));
});

it.effect("keeps a checkout that gains an ignored file during the final checks", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repositoryRoot = yield* initializeRepository();
    state.projects = [makeProject(repositoryRoot)];
    const worktreePath = yield* addWorktree(repositoryRoot, "late-secret");
    const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
    const secret = path.join(worktreePath, ".env");

    // Written after the first inspection found no ignored files. The branch
    // and commit do not move, and Git alone would delete the file.
    const outcome = yield* (yield* WorktreeService.WorktreeService).removeIfSafe({
      path: worktreePath,
      workspaceRoot: repositoryRoot,
      intent: "policy",
      expected: { branch: "feature/late-secret", headSha: head.commitSha },
      recheck: fs.writeFileString(secret, "TOKEN=1\n").pipe(Effect.as(true), Effect.orDie),
    });

    assert.deepEqual(outcome, { outcome: "skipped", reason: "ignored_files", detail: ".env" });
    assert.isTrue(yield* fs.exists(secret));
  }).pipe(Effect.provide(layer));
});

it.effect("keeps cleanup away from ignored files and running threads", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repositoryRoot = yield* initializeRepository();
    state.projects = [makeProject(repositoryRoot)];
    const worktrees = yield* WorktreeService.WorktreeService;
    const removeByPolicy = Effect.fn(function* (worktreePath: string, name: string) {
      const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
      const outcome = yield* worktrees.removeIfSafe({
        path: worktreePath,
        workspaceRoot: repositoryRoot,
        intent: "policy",
        expected: { branch: `feature/${name}`, headSha: head.commitSha },
        recheck: Effect.succeed(true),
      });
      return outcome.outcome === "removed" ? "removed" : outcome.reason;
    });

    const withSecrets = yield* addWorktree(repositoryRoot, "policy-secrets");
    yield* fs.writeFileString(path.join(withSecrets, ".env"), "TOKEN=1\n");
    assert.equal(yield* removeByPolicy(withSecrets, "policy-secrets"), "ignored_files");

    const running = yield* addWorktree(repositoryRoot, "policy-running");
    state.threads = [linkedThread(running, { status: "starting" })];
    assert.equal(yield* removeByPolicy(running, "policy-running"), "running");
    state.threads = [];

    const withDependencies = yield* addWorktree(repositoryRoot, "policy-dependencies");
    yield* fs.makeDirectory(path.join(withDependencies, "node_modules"));
    yield* fs.writeFileString(path.join(withDependencies, "node_modules", "index.js"), "");
    assert.equal(yield* removeByPolicy(withDependencies, "policy-dependencies"), "removed");
  }).pipe(Effect.provide(layer));
});

it.effect("recreates the checkout for a turn that starts while it is being removed", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repositoryRoot = yield* initializeRepository();
    state.projects = [makeProject(repositoryRoot)];
    const worktreePath = yield* addWorktree(repositoryRoot, "race");
    const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
    const worktrees = yield* WorktreeService.WorktreeService;
    const revival = yield* WorktreeRevivalService.WorktreeRevivalService;
    const removalHoldsLease = yield* Deferred.make<void>();
    const finishRemoval = yield* Deferred.make<void>();

    // The recheck runs under the lease, after the removal's final reads.
    const removal = yield* worktrees
      .removeIfSafe({
        path: worktreePath,
        workspaceRoot: repositoryRoot,
        intent: "policy",
        expected: { branch: "feature/race", headSha: head.commitSha },
        recheck: Deferred.succeed(removalHoldsLease, undefined).pipe(
          Effect.andThen(Deferred.await(finishRemoval)),
          Effect.as(true),
        ),
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(removalHoldsLease);
    const turnStart = yield* revival
      .reviveForThread({
        threadId: ThreadId.make("thread-race"),
        projectId,
        worktreePath,
        branch: "feature/race",
      })
      .pipe(Effect.forkChild);
    yield* Deferred.succeed(finishRemoval, undefined);

    assert.deepEqual(yield* Fiber.join(removal), { outcome: "removed" });
    assert.deepEqual(yield* Fiber.join(turnStart), { revived: true, generation: 1 });
    assert.isTrue(yield* fs.exists(path.join(worktreePath, "README.md")));
  }).pipe(Effect.provide(layer));
});

it.effect("lists managed worktrees with what removal would delete or keep", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const repositoryRoot = yield* initializeRepository();
    const notARepository = yield* fs.makeTempDirectoryScoped({ prefix: "t3-worktree-plain-" });
    state.projects = [
      makeProject(repositoryRoot),
      { ...makeProject(notARepository), id: ProjectId.make("project-plain") },
    ];
    const detached = yield* addWorktree(repositoryRoot, "list-detached", { detached: true });
    const head = yield* git.resolveCommit({ cwd: detached, revision: "HEAD" });
    const busy = yield* addWorktree(repositoryRoot, "list-busy");
    yield* fs.writeFileString(path.join(busy, ".env"), "TOKEN=1\n");
    yield* fs.writeFileString(path.join(busy, "notes.txt"), "draft\n");
    yield* commitIn(busy);
    // A pull request refresh touched the thread long after its last run.
    const lastRun = DateTime.makeUnsafe("2026-05-20T00:00:00.000Z");
    state.threads = [
      linkedThread(busy, {
        title: "Busy thread",
        latestRunCompletedAt: lastRun,
        updatedAt: DateTime.makeUnsafe("2026-06-01T00:00:00.000Z"),
      }),
    ];

    const result = yield* (yield* WorktreeService.WorktreeService).listWorktrees({});
    const byPath = new Map(result.worktrees.map((worktree) => [worktree.path, worktree]));

    assert.equal(result.revision, 0);
    assert.equal(result.worktrees.length, 2);
    assert.deepInclude(byPath.get(detached), {
      branch: null,
      headShortSha: head.commitSha.slice(0, 7),
      dirtyFileCount: 0,
      ignoredFileCount: 0,
      aheadOfDefaultCount: 0,
      safeToPrune: true,
      pruneBlockers: [],
    });
    assert.deepInclude(byPath.get(busy), {
      projectId,
      branch: "feature/list-busy",
      dirtyFileCount: 1,
      ignoredFileCount: 1,
      ignoredFiles: [".env"],
      lastActivityAt: DateTime.formatIso(lastRun),
      aheadOfDefaultCount: 1,
      safeToPrune: false,
      pruneBlockers: ["dirty", "unpushed", "open_thread"],
    });
    assert.deepEqual(
      byPath.get(busy)?.threads.map((thread) => [thread.title, thread.status]),
      [["Busy thread", "active"]],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("applies the cleanup policy to files written during its final checks", () => {
  const { state, layer } = makeHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const worktrees = yield* WorktreeService.WorktreeService;
    const repositoryRoot = yield* initializeRepository();
    state.projects = [makeProject(repositoryRoot)];
    for (const keepWhen of ["any-local-files", "uncommitted-changes", "tracked-changes"] as const) {
      for (const file of ["README.md", "notes.txt", ".env"] as const) {
        const name = `${keepWhen}-${file.replaceAll(".", "-")}`;
        const worktreePath = yield* addWorktree(repositoryRoot, name);
        const { commitSha } = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
        const result = yield* worktrees.removeIfSafe({
          intent: "policy",
          path: worktreePath,
          workspaceRoot: repositoryRoot,
          keepWhen,
          expected: { branch: `feature/${name}`, headSha: commitSha },
          recheck: fs
            .writeFileString(path.join(worktreePath, file), "local content\n")
            .pipe(Effect.as(true), Effect.orDie),
        });
        const shouldRemove =
          file !== "README.md" &&
          (keepWhen === "tracked-changes" ||
            (keepWhen === "uncommitted-changes" && file === ".env"));
        assert.equal(result.outcome, shouldRemove ? "removed" : "skipped", `${keepWhen}: ${file}`);
        assert.equal(yield* fs.exists(worktreePath), !shouldRemove);
        assert.equal(
          (yield* git.resolveCommit({
            cwd: repositoryRoot,
            revision: `refs/heads/feature/${name}`,
          })).commitSha,
          commitSha,
        );
      }
    }
  }).pipe(Effect.provide(layer));
});
