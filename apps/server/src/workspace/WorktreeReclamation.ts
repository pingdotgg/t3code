import {
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
  WorktreeReclaimError,
  type WorktreeReclaimInput,
  type WorktreeReclaimRefusal,
  type WorktreeReclaimResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { threadShellHasActiveWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  readLiveProviderSessionCwds,
  storageCleanupActivityAt,
  storageCleanupThreadIdle,
} from "../storageCleanup.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "./workspaceLease.ts";

/** Live state the eligibility checks read. Production reads projections, sessions and terminals. */
export interface ReclamationState {
  /** Every live (not deleted) thread, archived ones included. */
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
  readonly liveSessionCwds: ReadonlyArray<string>;
  readonly liveTerminalCwds: ReadonlyArray<string>;
}

export interface ReclamationRuntime {
  readonly worktreesDir: string;
  readonly readState: Effect.Effect<ReclamationState, WorktreeReclaimError>;
  readonly hasActiveDescendants: (
    threadId: ThreadId,
  ) => Effect.Effect<boolean, WorktreeReclaimError>;
  readonly afterRemove: (projectRoot: string) => Effect.Effect<void>;
}

export class WorktreeReclamation extends Context.Service<
  WorktreeReclamation,
  {
    readonly reclaim: (
      input: WorktreeReclaimInput,
    ) => Effect.Effect<WorktreeReclaimResult, WorktreeReclaimError>;
  }
>()("t3/workspace/WorktreeReclamation") {}

// Dependency installs and build outputs are reproducible from the preserved
// branch. Any other ignored path (.env files, local databases, datasets) keeps
// the checkout until someone removes it deliberately.
const REGENERABLE_DIRECTORIES = new Set([
  "node_modules",
  ".vite-hooks",
  ".turbo",
  ".next",
  ".nuxt",
  ".vite",
  ".cache",
  "dist",
  "coverage",
  "target",
  "__pycache__",
  ".pytest_cache",
  ".gradle",
  ".expo",
  "DerivedData",
  "Pods",
]);

/** Whether an entry from `git ls-files --others --ignored --directory` can be regenerated. */
export function regenerableIgnoredPath(entry: string): boolean {
  // T3 rewrites its managed agent instructions on every session start.
  if (entry.startsWith(".agents/t3/") || entry.endsWith(".tsbuildinfo")) return true;
  return entry
    .split("/")
    .slice(0, -1)
    .some((segment) => REGENERABLE_DIRECTORIES.has(segment));
}

const IGNORED_SAMPLE_LIMIT = 5;

interface Inspection {
  readonly thread: OrchestrationV2ThreadShell | null;
  readonly worktreePath: string | null;
  readonly projectRoot: string | null;
  readonly absent: boolean;
  readonly head: string | null;
  readonly refusals: ReadonlyArray<WorktreeReclaimRefusal>;
}

const isReclaimError = Schema.is(WorktreeReclaimError);

const toReclaimError = (prefix: string) =>
  Effect.mapError((error: unknown) =>
    isReclaimError(error)
      ? error
      : new WorktreeReclaimError({
          message: `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
        }),
  );

export const make = Effect.fn("WorktreeReclamation.make")(function* (runtime: ReclamationRuntime) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const processes = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const overlaps = (left: string, right: string) =>
    left === right || inside(left, right) || inside(right, left);

  /** Allocated (not logical) bytes, via `du`, which counts hard links once. */
  const allocatedBytes = Effect.fn("WorktreeReclamation.allocatedBytes")(
    function* (target: string) {
      if (!(yield* fs.exists(target))) return 0;
      if ((yield* HostProcess.Platform) === "win32") return null;
      const result = yield* processes.run({
        command: "du",
        args: ["-sk", target],
        timeout: "2 minutes",
        maxOutputBytes: 4096,
      });
      const kib = Number.parseInt(result.stdout.trim().split(/\s+/)[0] ?? "", 10);
      return result.code === 0 && Number.isFinite(kib) ? kib * 1024 : null;
    },
    Effect.orElseSucceed(() => null),
  );

  /** Default-branch refs of every remote, fetched first when `fetch` is set. */
  const defaultBranchRefs = Effect.fn("WorktreeReclamation.defaultBranchRefs")(function* (
    cwd: string,
    fetch: boolean,
  ) {
    const remotes = yield* git.execute({
      operation: "WorktreeReclamation.listRemotes",
      cwd,
      args: ["remote"],
    });
    const defaultRefs = new Set<string>();
    for (const remote of remotes.stdout.split("\n").map((line) => line.trim())) {
      if (remote === "") continue;
      const declared = yield* git.resolveDefaultBranchName(cwd, remote);
      // A remote added after clone (a fork's second remote) usually has no HEAD.
      const candidates = declared === null ? ["main", "master"] : [declared];
      for (const branch of candidates) {
        if (fetch) {
          // Offline or missing branches leave the local refs, which can only refuse more.
          yield* git
            .fetchRemoteTrackingBranch({ cwd, remoteName: remote, remoteBranch: branch })
            .pipe(Effect.ignore);
        }
        defaultRefs.add(`refs/remotes/${remote}/${branch}`);
      }
    }
    return defaultRefs;
  });

  const inspect = Effect.fn("WorktreeReclamation.inspect")(function* (
    threadId: ThreadId,
    options: { readonly fetch: boolean },
  ) {
    const state = yield* runtime.readState;
    const thread = state.threads.find((entry) => entry.id === threadId) ?? null;
    const done = (
      refusals: ReadonlyArray<WorktreeReclaimRefusal>,
      fields: Partial<Inspection> = {},
    ): Inspection => ({
      thread,
      worktreePath: null,
      projectRoot: null,
      absent: false,
      head: null,
      refusals,
      ...fields,
    });
    if (thread === null) {
      return done([{ code: "thread_not_found", message: `Thread '${threadId}' was not found.` }]);
    }
    if (thread.worktreePath === null || thread.branch === null) {
      return done([
        {
          code: "no_worktree",
          message: "The thread works in its project checkout, not a worktree of its own.",
        },
      ]);
    }
    const worktreePath = path.resolve(thread.worktreePath);
    if (!(yield* fs.exists(worktreePath))) return done([], { worktreePath, absent: true });

    const project = state.projects.find((entry) => entry.id === thread.projectId);
    const root = yield* fs.realPath(runtime.worktreesDir).pipe(Effect.orElseSucceed(() => null));
    const linked = yield* fs.stat(path.join(worktreePath, ".git")).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );
    if (
      project === undefined ||
      root === null ||
      !inside(root, worktreePath) ||
      (yield* fs.realPath(worktreePath)) !== worktreePath ||
      !linked
    ) {
      return done(
        [
          {
            code: "not_server_managed",
            message:
              project === undefined
                ? "The thread's project is no longer registered."
                : `Only linked worktrees T3 created under '${runtime.worktreesDir}' can be reclaimed.`,
          },
        ],
        { worktreePath },
      );
    }
    const projectRoot = path.resolve(project.workspaceRoot);
    const projectRoots = yield* Effect.forEach(state.projects, (entry) =>
      fs.realPath(entry.workspaceRoot).pipe(Effect.orElseSucceed(() => entry.workspaceRoot)),
    );
    if (
      [...projectRoots, ...state.projects.map((entry) => entry.workspaceRoot)].some((candidate) => {
        const resolved = path.resolve(candidate);
        return resolved === worktreePath || inside(worktreePath, resolved);
      })
    ) {
      return done(
        [{ code: "contains_project", message: "A registered project lives in this checkout." }],
        { worktreePath },
      );
    }

    const refusals: Array<WorktreeReclaimRefusal> = [];
    const now = yield* Clock.currentTimeMillis;
    // An armed usage-limit recovery still holds; a manual reclaim does not wait for one to arm.
    const holdArmedRecoveryOnly = { autoResumeLimitedThreads: false, snoozeLimitedThreads: false };
    if (
      !storageCleanupThreadIdle(thread, now, holdArmedRecoveryOnly) ||
      threadShellHasActiveWork(thread)
    ) {
      refusals.push({
        code: "thread_active",
        message: "The thread has a running, queued or pending turn, request or background task.",
      });
    }
    if (yield* runtime.hasActiveDescendants(thread.id)) {
      refusals.push({
        code: "descendant_active",
        message: "A child chat or delegated subagent of this thread is still working.",
      });
    }
    const sharing = state.threads.filter(
      (entry) =>
        entry.id !== thread.id &&
        entry.worktreePath !== null &&
        overlaps(path.resolve(entry.worktreePath), worktreePath),
    );
    if (sharing.length > 0) {
      refusals.push({
        code: "shared_binding",
        message: `Other threads are bound to this checkout: ${sharing.map((entry) => entry.id).join(", ")}.`,
      });
    }
    if (state.liveSessionCwds.some((cwd) => overlaps(path.resolve(cwd), worktreePath))) {
      refusals.push({
        code: "live_session",
        message:
          "A provider session is still open in this checkout. Stop the thread's session first.",
      });
    }
    if (state.liveTerminalCwds.some((cwd) => overlaps(path.resolve(cwd), worktreePath))) {
      refusals.push({
        code: "live_terminal",
        message: "A terminal is still running in this checkout.",
      });
    }

    const status = yield* git.statusDetailsLocal(worktreePath);
    if (status.branch !== thread.branch) {
      refusals.push({
        code: "branch_mismatch",
        message: `The checkout is on '${status.branch ?? "a detached HEAD"}', not the bound branch '${thread.branch}'.`,
      });
    }
    if (status.hasWorkingTreeChanges) {
      refusals.push({
        code: "uncommitted_changes",
        message: "The checkout has uncommitted or untracked changes.",
      });
    }
    const ignored = yield* git.execute({
      operation: "WorktreeReclamation.ignoredFiles",
      cwd: worktreePath,
      args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      maxOutputBytes: 256 * 1024,
    });
    const kept = ignored.stdout
      .split("\0")
      .filter((entry) => entry !== "" && !regenerableIgnoredPath(entry));
    if (ignored.stdoutTruncated || kept.length > 0) {
      const sample = kept.slice(0, IGNORED_SAMPLE_LIMIT).join(", ");
      const more =
        kept.length > IGNORED_SAMPLE_LIMIT ? ` and ${kept.length - IGNORED_SAMPLE_LIMIT} more` : "";
      refusals.push({
        code: "ignored_files",
        message: ignored.stdoutTruncated
          ? "Too many ignored files to inspect safely."
          : `Ignored files that cannot be regenerated would be lost: ${sample}${more}. Remove or move them first.`,
      });
    }

    const head = (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha;
    // The locked recheck only re-reads local refs; the first pass fetched.
    const defaultRefs = yield* defaultBranchRefs(projectRoot, options.fetch);
    const containing = (yield* git.execute({
      operation: "WorktreeReclamation.remoteRefsContainingHead",
      cwd: worktreePath,
      args: ["for-each-ref", "--contains", head, "--format=%(refname)", "refs/remotes"],
      maxOutputBytes: 256 * 1024,
    })).stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (containing.length === 0) {
      refusals.push({
        code: "unpushed",
        message: `Commit ${head.slice(0, 12)} is not on any remote branch.`,
      });
    }
    // Merge evidence must name this exact commit. Pull request snapshots carry no
    // head commit, so a merged link cannot prove a later push was merged; squash
    // merges are refused here and left to the inactivity cleanup policy.
    if (!containing.some((ref) => defaultRefs.has(ref))) {
      refusals.push({
        code: "unmerged",
        message: `Commit ${head.slice(0, 12)} on '${thread.branch}' is not in a remote default branch. Squash-merged branches cannot be proven merged.`,
      });
    }
    return done(refusals, { worktreePath, projectRoot, head });
  });

  const reclaim: WorktreeReclamation["Service"]["reclaim"] = Effect.fn(
    "WorktreeReclamation.reclaim",
  )(function* (input) {
    const result = (
      inspection: Inspection,
      status: WorktreeReclaimResult["status"],
      allocatedBytesBefore: number | null,
      allocatedBytesAfter: number | null,
    ): WorktreeReclaimResult => ({
      threadId: input.threadId,
      worktreePath: inspection.worktreePath ?? inspection.thread?.worktreePath ?? null,
      branch: inspection.thread?.branch ?? null,
      status,
      refusals: inspection.refusals,
      allocatedBytesBefore,
      allocatedBytesAfter,
    });

    const first = yield* inspect(input.threadId, { fetch: true });
    if (first.absent) return result(first, "already_absent", 0, 0);
    const worktreePath = first.worktreePath;
    const before = worktreePath === null ? null : yield* allocatedBytes(worktreePath);
    if (first.refusals.length > 0) return result(first, "refused", before, before);
    if (input.dryRun === true) return result(first, "eligible", before, before);

    // The lease orders this removal against terminal launches and the turn
    // start that recreates a missing checkout. Everything is re-read under it:
    // a turn requested since the first pass is visible in the projection.
    const removed = yield* withWorkspaceLease(
      worktreePath!,
      Effect.gen(function* () {
        const second = yield* inspect(input.threadId, { fetch: false });
        if (second.absent) return { inspection: second, status: "already_absent" as const };
        const changed =
          second.head !== first.head ||
          second.thread === null ||
          first.thread === null ||
          storageCleanupActivityAt(second.thread) !== storageCleanupActivityAt(first.thread);
        if (second.refusals.length > 0 || changed) {
          const refusals = changed
            ? [
                ...second.refusals,
                {
                  code: "changed_during_reclaim" as const,
                  message:
                    "The thread or its checkout changed while reclaiming; nothing was removed.",
                },
              ]
            : second.refusals;
          return { inspection: { ...second, refusals }, status: "refused" as const };
        }
        // Not forced: git itself refuses if tracked or untracked changes appeared.
        yield* git.removeWorktree({ cwd: second.projectRoot!, path: worktreePath!, force: false });
        yield* runtime.afterRemove(second.projectRoot!);
        yield* Effect.logInfo("reclaimed worktree checkout", {
          threadId: input.threadId,
          worktreePath,
          allocatedBytes: before,
        });
        return { inspection: second, status: "reclaimed" as const };
      }),
    );
    const after = yield* allocatedBytes(worktreePath!);
    return result(removed.inspection, removed.status, before, after);
  }, toReclaimError("Unable to reclaim the worktree"));

  return WorktreeReclamation.of({ reclaim });
});

export const layer = Layer.effect(
  WorktreeReclamation,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const sessionManager = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const terminals = yield* TerminalManager.TerminalManager;
    const gitManager = yield* GitManager.GitManager;

    const liveTerminalCwds = Effect.gen(function* () {
      // subscribeMetadata delivers its snapshot before returning.
      let cwds: ReadonlyArray<string> = [];
      const unsubscribe = yield* terminals.subscribeMetadata((event) =>
        Effect.sync(() => {
          if (event.type !== "snapshot") return;
          cwds = event.terminals
            .filter((terminal) => terminal.status === "starting" || terminal.status === "running")
            .flatMap((terminal) =>
              terminal.worktreePath === null
                ? [terminal.cwd]
                : [terminal.cwd, terminal.worktreePath],
            );
        }),
      );
      unsubscribe();
      return cwds;
    });

    const readState: ReclamationRuntime["readState"] = Effect.gen(function* () {
      const active = yield* projections.getShellSnapshot();
      const archived = yield* projections.getShellSnapshot({ location: "archive" });
      const projects = yield* projectStore.listShells();
      const liveSessionCwds = yield* readLiveProviderSessionCwds().pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, sessionManager),
      );
      return {
        threads: [...active.threads, ...archived.threads].filter(
          (thread) => thread.deletedAt === null,
        ),
        projects,
        liveSessionCwds,
        liveTerminalCwds: yield* liveTerminalCwds,
      };
    }).pipe(toReclaimError("Unable to read thread state"));

    return yield* make({
      worktreesDir: config.worktreesDir,
      readState,
      hasActiveDescendants: (threadId) =>
        projections
          .hasActiveDescendants(threadId)
          .pipe(toReclaimError("Unable to read child threads")),
      afterRemove: gitManager.invalidateStatus,
    });
  }),
);
