import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type TerminalSummary,
  type VcsListWorktreesInput,
  type VcsListWorktreesResult,
  type VcsPruneWorktreesInput,
  type VcsPruneWorktreesResult,
  type VcsRemoveWorktreeInput,
  type VcsWorkspace,
  type WorktreeInfo,
  type WorktreeInventoryErrorStage,
  type WorktreePruneBlocker,
  type WorktreePruneSkip,
  type WorktreeThreadStatus,
  WorktreeInventoryError,
  WorktreeMutationError,
  WorktreePruneSkipReason,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { resolveWorkspaceLeasePath, withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as WorktreeLifecycle from "./WorktreeLifecycle.ts";
import { storageCleanupActivityAt, worktreeThreadBusy } from "./worktreeThreadState.ts";

const WORKTREE_STATUS_CONCURRENCY = 8;
const PROJECT_SCAN_CONCURRENCY = 4;
// As large as the other Git metadata reads. A file pattern such as `*.log`
// lists every match, so a small cap left ordinary worktrees unreadable.
const STATUS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const IGNORED_FILE_SAMPLE_SIZE = 5;

const SKIP_REASON_MESSAGE: Record<WorktreePruneSkipReason, string> = {
  running: "a thread is running or has a queued turn in it",
  session: "a provider session is using it",
  terminal: "a terminal is open in it",
  open_thread: "a linked thread is still open",
  dirty: "it has uncommitted changes",
  unpushed: "it has commits that are not pushed or merged",
  unrestorable_thread: "a linked thread could not get this checkout back",
  status_unavailable: "its Git status could not be read",
  ignored_files: "it holds ignored files that removal would delete",
  protected_path: "it is not a removable managed worktree",
  unknown_worktree: "Git does not register it for this project",
  changed: "it changed while it was being checked",
  policy_changed: "the cleanup rule no longer applies",
  remove_failed: "Git could not remove it",
};

/** A removal request that left the worktree in place, with the reason. */
export class WorktreeRemovalSkippedError extends Schema.TaggedError<WorktreeRemovalSkippedError>()(
  "WorktreeRemovalSkippedError",
  {
    path: Schema.String,
    reason: WorktreePruneSkipReason,
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `The worktree was kept because ${SKIP_REASON_MESSAGE[this.reason]}.`;
  }
}

type RemovalOutcome =
  | { readonly outcome: "removed" }
  | {
      readonly outcome: "skipped";
      readonly reason: WorktreePruneSkipReason;
      readonly detail?: string;
    };

/**
 * `manual` is a user or agent asking for one worktree. `policy` is Storage
 * cleanup acting on its configured rules: it names the branch and commit its
 * eligibility was decided on and supplies `recheck`, which runs under the
 * lease with the service's own final reads and must still hold.
 */
export type WorktreeRemovalInput = {
  readonly path: string;
  readonly workspaceRoot: string;
} & (
  | { readonly intent: "manual"; readonly allowIgnoredFiles?: boolean }
  | {
      readonly intent: "policy";
      readonly expected: { readonly branch: string; readonly headSha: string };
      readonly recheck: Effect.Effect<boolean>;
    }
);

interface ProjectReference {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

interface ProjectGroup {
  readonly canonicalWorkspaceRoot: string;
  readonly projects: ReadonlyArray<ProjectReference>;
}

/** One `git status` read of a checkout. */
interface WorktreeInspection {
  readonly headSha: string | null;
  readonly branch: string | null;
  readonly upstream: string | null;
  /** null with an upstream means its remote ref is gone. */
  readonly aheadOfUpstreamCount: number | null;
  readonly behindUpstreamCount: number | null;
  readonly changedFileCount: number;
  /** Ignored paths other than reproducible dependency installs. */
  readonly ignoredFiles: ReadonlyArray<string>;
}

interface WorktreeUsage {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly hasSession: boolean;
  readonly hasTerminal: boolean;
}

/** Parses `git status --porcelain=v2 --branch -z --ignored=matching`. */
function parseWorktreeStatus(stdout: string): WorktreeInspection {
  let headSha: string | null = null;
  let branch: string | null = null;
  let upstream: string | null = null;
  let aheadOfUpstreamCount: number | null = null;
  let behindUpstreamCount: number | null = null;
  let changedFileCount = 0;
  const ignoredFiles: string[] = [];
  const tokens = stdout.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.length === 0) continue;
    if (token.startsWith("# branch.oid ")) {
      const oid = token.slice("# branch.oid ".length);
      headSha = oid === "(initial)" ? null : oid;
    } else if (token.startsWith("# branch.head ")) {
      const head = token.slice("# branch.head ".length);
      branch = head === "(detached)" ? null : head;
    } else if (token.startsWith("# branch.upstream ")) {
      upstream = token.slice("# branch.upstream ".length);
    } else if (token.startsWith("# branch.ab ")) {
      const match = /^\+(\d+) -(\d+)$/.exec(token.slice("# branch.ab ".length));
      if (match !== null) {
        aheadOfUpstreamCount = Number(match[1]);
        behindUpstreamCount = Number(match[2]);
      }
    } else if (token.startsWith("! ")) {
      const ignored = token.slice(2);
      // Dependency installs are reproducible; every other ignored path can
      // hold secrets or local data.
      if (!/(^|\/)node_modules\/$/.test(ignored)) ignoredFiles.push(ignored);
    } else if (!token.startsWith("#")) {
      changedFileCount += 1;
      // A rename or copy carries its original path as the following token.
      if (token.startsWith("2 ")) index += 1;
    }
  }
  return {
    headSha,
    branch,
    upstream,
    aheadOfUpstreamCount,
    behindUpstreamCount,
    changedFileCount,
    ignoredFiles,
  };
}

/** A named branch whose upstream ref exists is compared with that upstream. */
const hasUsableUpstream = (inspection: WorktreeInspection) =>
  inspection.branch !== null &&
  inspection.upstream !== null &&
  inspection.aheadOfUpstreamCount !== null;

function threadStatus(thread: OrchestrationV2ThreadShell): WorktreeThreadStatus {
  if (thread.deletedAt !== null) return "deleted";
  if (thread.archivedAt !== null) return "archived";
  if (thread.settledOverride === "settled") return "settled";
  return "active";
}

/**
 * The one removal decision, listed most pressing first. Inventory rows show
 * it and removal re-derives it under the lease. Ignored files are not here:
 * they need the caller's opt-in rather than blocking outright.
 */
function removalBlockers(input: {
  readonly intent: WorktreeRemovalInput["intent"];
  readonly inspection: WorktreeInspection | null;
  /** Commits missing from the default ref; only read without a usable upstream. */
  readonly aheadOfDefaultCount: number | null;
  readonly usage: WorktreeUsage;
  readonly now: number;
}): ReadonlyArray<WorktreePruneBlocker> {
  const { inspection, usage } = input;
  const manual = input.intent === "manual";
  const blockers = new Set<WorktreePruneBlocker>();
  if (usage.threads.some((thread) => worktreeThreadBusy(thread, input.now))) {
    blockers.add("running");
  }
  if (usage.hasSession) blockers.add("session");
  if (usage.hasTerminal) blockers.add("terminal");
  if (inspection === null || inspection.headSha === null) {
    blockers.add("status_unavailable");
  } else {
    if (inspection.changedFileCount > 0) blockers.add("dirty");
    if (inspection.branch === null) {
      // No ref keeps a detached commit, so it must already be on the default
      // branch for either intent.
      if (input.aheadOfDefaultCount === null) blockers.add("status_unavailable");
      else if (input.aheadOfDefaultCount > 0) blockers.add("unpushed");
    } else if (manual) {
      // Cleanup may remove a checkout with unpushed commits because the branch
      // is kept. A manual removal promises the work is already elsewhere.
      if (hasUsableUpstream(inspection)) {
        if ((inspection.aheadOfUpstreamCount ?? 0) > 0) blockers.add("unpushed");
      } else if (input.aheadOfDefaultCount === null) {
        blockers.add("status_unavailable");
      } else if (input.aheadOfDefaultCount > 0) {
        blockers.add("unpushed");
      }
    }
  }
  // Revival recreates a checkout from the branch its thread recorded. A thread
  // without one, or any thread on a detached checkout, would be left with a
  // path nothing can restore.
  if (
    manual &&
    usage.threads.some((thread) => thread.branch === null || inspection?.branch === null)
  ) {
    blockers.add("unrestorable_thread");
  }
  if (manual && usage.threads.some((thread) => threadStatus(thread) === "active")) {
    blockers.add("open_thread");
  }
  return [...blockers];
}

function inventoryError(
  stage: WorktreeInventoryErrorStage,
  cause: unknown,
  context: { readonly workspaceRoot?: string } = {},
): WorktreeInventoryError {
  return new WorktreeInventoryError({
    stage,
    ...(context.workspaceRoot === undefined ? {} : { workspaceRoot: context.workspaceRoot }),
    cause,
  });
}

export class WorktreeService extends Context.Service<
  WorktreeService,
  {
    readonly listWorktrees: (
      input: VcsListWorktreesInput,
    ) => Effect.Effect<VcsListWorktreesResult, WorktreeInventoryError>;
    /** Manual removal of a project's worktrees. Each path is removed or skipped with its reason. */
    readonly pruneWorktrees: (
      input: VcsPruneWorktreesInput,
    ) => Effect.Effect<VcsPruneWorktreesResult, WorktreeMutationError>;
    /**
     * The legacy single-worktree removal. It is a manual removal: `force` is
     * ignored and ignored files are never opted in.
     */
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, WorktreeRemovalSkippedError>;
    /**
     * Removes one checkout if every safeguard holds, keeping its branch and
     * checkpoint refs. Never forces Git and never fails: a refusal is a skip.
     */
    readonly removeIfSafe: (input: WorktreeRemovalInput) => Effect.Effect<RemovalOutcome>;
  }
>()("t3/vcs/WorktreeService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const terminals = yield* TerminalManager.TerminalManager;
  const lifecycle = yield* WorktreeLifecycle.WorktreeLifecycle;

  const liveTerminals = new Map<string, Map<string, TerminalSummary>>();
  const noteTerminal = (terminal: TerminalSummary) => {
    const threadTerminals =
      liveTerminals.get(terminal.threadId) ?? new Map<string, TerminalSummary>();
    threadTerminals.set(terminal.terminalId, terminal);
    liveTerminals.set(terminal.threadId, threadTerminals);
  };
  const unsubscribeTerminals = yield* terminals.subscribeMetadata((event) =>
    Effect.sync(() => {
      if (event.type === "snapshot") {
        liveTerminals.clear();
        for (const terminal of event.terminals) noteTerminal(terminal);
      } else if (event.type === "upsert") {
        noteTerminal(event.terminal);
      } else {
        const threadTerminals = liveTerminals.get(event.threadId);
        threadTerminals?.delete(event.terminalId);
        if (threadTerminals?.size === 0) liveTerminals.delete(event.threadId);
      }
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribeTerminals));

  // Canonicalize through symlinks so configured roots, Git metadata, thread
  // paths and lease keys compare equal on hosts such as macOS (/var vs
  // /private/var) or with a symlinked T3 home.
  const canonicalizePath = (value: string) =>
    resolveWorkspaceLeasePath(value).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const managedWorktreesRoot = yield* canonicalizePath(config.worktreesDir);

  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const atOrInside = (root: string, target: string) => root === target || inside(root, target);

  const executeLenient = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({
        operation,
        cwd,
        args,
        env: { LC_ALL: "C" },
        allowNonZeroExit: true,
        timeoutMs: 15_000,
      })
      .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout : null)));

  /**
   * The ref a checkout's commits must reach to count as merged: the primary
   * remote's default branch as last fetched. Nothing is fetched here, and a
   * stale ref can only make commits look unmerged. A repository without any
   * remote falls back to its local default branch.
   */
  const resolveDefaultRef = Effect.fn("WorktreeService.resolveDefaultRef")(function* (cwd: string) {
    const remote = yield* git.resolvePrimaryRemoteName(cwd).pipe(Effect.option);
    if (Option.isSome(remote)) {
      const branch = yield* git.resolveDefaultBranchName(cwd, remote.value);
      return branch === null ? null : `refs/remotes/${remote.value}/${branch}`;
    }
    for (const candidate of ["refs/heads/main", "refs/heads/master"]) {
      const result = yield* git.execute({
        operation: "WorktreeService.resolveDefaultRef.localFallback",
        cwd,
        args: ["show-ref", "--verify", "--quiet", candidate],
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      });
      if (result.exitCode === 0) return candidate;
    }
    return null;
  });

  /** Commits reachable from `commit` that the default ref does not have. */
  const countAheadOfDefault = Effect.fn("WorktreeService.countAheadOfDefault")(function* (
    cwd: string,
    commit: string,
    defaultRef: string | null,
  ) {
    if (defaultRef === null) return null;
    const stdout = yield* executeLenient("WorktreeService.countAheadOfDefault", cwd, [
      "rev-list",
      "--count",
      commit,
      "--not",
      defaultRef,
    ]);
    if (stdout === null) return null;
    const count = Number(stdout.trim());
    return Number.isInteger(count) && count >= 0 ? count : null;
  });

  /**
   * Branch, HEAD commit, upstream counters, changed files and ignored files
   * from one `git status` call. null when the status cannot be read in full:
   * a partial listing could hide a changed or ignored file.
   */
  const inspect = Effect.fn("WorktreeService.inspect")(
    function* (worktreePath: string) {
      const result = yield* git.execute({
        operation: "WorktreeService.inspect",
        cwd: worktreePath,
        args: [
          "status",
          "--porcelain=v2",
          "--branch",
          "-z",
          "--untracked-files=normal",
          "--ignored=matching",
        ],
        env: { LC_ALL: "C" },
        timeoutMs: 15_000,
        maxOutputBytes: STATUS_MAX_OUTPUT_BYTES,
      });
      return result.stdoutTruncated ? null : parseWorktreeStatus(result.stdout);
    },
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logDebug("worktrees.inspect.status-failed", { cause }).pipe(Effect.as(null)),
    ),
  );

  /** The default-ref comparison a checkout needs, measured on its captured commit. */
  const aheadOfDefaultFor = (
    worktreePath: string,
    inspection: WorktreeInspection | null,
    defaultRef: string | null,
  ) =>
    inspection === null || inspection.headSha === null || hasUsableUpstream(inspection)
      ? Effect.succeed(null)
      : countAheadOfDefault(worktreePath, inspection.headSha, defaultRef);

  const readProjects = projectStore.listShells();
  const readThreads = projections
    .getShellSnapshot()
    .pipe(Effect.map((snapshot) => [...snapshot.threads, ...snapshot.archivedThreads]));

  // Sessions can outlive their run and can be shared across app threads.
  const readSessionCwds = sql<{ readonly cwd: string | null }>`
    SELECT json_extract(payload_json, '$.cwd') AS cwd
    FROM orchestration_v2_projection_provider_sessions
    WHERE status != 'stopped'
  `.pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(
        rows.flatMap((row) => (row.cwd === null ? [] : [row.cwd])),
        canonicalizePath,
      ),
    ),
  );

  const readTerminalCwds = Effect.suspend(() =>
    Effect.forEach(
      [...liveTerminals.values()]
        .flatMap((entries) => [...entries.values()])
        .filter((terminal) => terminal.status === "starting" || terminal.status === "running")
        .flatMap((terminal) =>
          terminal.worktreePath === null ? [terminal.cwd] : [terminal.cwd, terminal.worktreePath],
        ),
      canonicalizePath,
    ),
  );

  /** Every thread, session and terminal directory, read once and matched per checkout. */
  const readUsage = Effect.fn("WorktreeService.readUsage")(function* () {
    const threads = yield* readThreads;
    const canonicalByRawPath = new Map<string, string>();
    const threadsByPath = new Map<string, OrchestrationV2ThreadShell[]>();
    for (const thread of threads) {
      if (thread.worktreePath === null) continue;
      const canonicalPath =
        canonicalByRawPath.get(thread.worktreePath) ??
        (yield* canonicalizePath(thread.worktreePath));
      canonicalByRawPath.set(thread.worktreePath, canonicalPath);
      const bucket = threadsByPath.get(canonicalPath);
      if (bucket === undefined) threadsByPath.set(canonicalPath, [thread]);
      else bucket.push(thread);
    }
    const sessionCwds = yield* readSessionCwds;
    const terminalCwds = yield* readTerminalCwds;
    return (worktreePath: string): WorktreeUsage => ({
      // Every project's threads count: projects can share one repository.
      threads: threadsByPath.get(worktreePath) ?? [],
      hasSession: sessionCwds.some((cwd) => atOrInside(worktreePath, cwd)),
      hasTerminal: terminalCwds.some((cwd) => atOrInside(worktreePath, cwd)),
    });
  });

  // Local threads under another project need not have a worktreePath of their own.
  const containsProjectRoot = (
    worktreePath: string,
    canonicalProjectRoots: ReadonlyArray<string>,
  ) => canonicalProjectRoots.some((root) => atOrInside(worktreePath, root));

  const listCanonicalWorkspaces = (workspaceRoot: string) =>
    git
      .listWorkspaces(workspaceRoot)
      .pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(entries, (entry) =>
            canonicalizePath(entry.path).pipe(
              Effect.map((canonicalPath): VcsWorkspace => ({ ...entry, path: canonicalPath })),
            ),
          ),
        ),
      );

  const worktreeMtime = (worktreePath: string) =>
    fs.stat(worktreePath).pipe(
      Effect.map((info) =>
        Option.match(info.mtime, {
          onNone: () => null,
          onSome: (mtime) => mtime.toISOString(),
        }),
      ),
      Effect.orElseSucceed(() => null),
    );

  const listGroup = Effect.fn("WorktreeService.listGroup")(function* (
    group: ProjectGroup,
    usageFor: (worktreePath: string) => WorktreeUsage,
    canonicalProjectRoots: ReadonlyArray<string>,
    now: number,
  ) {
    const primaryProject = group.projects[0];
    if (primaryProject === undefined) return [] as WorktreeInfo[];

    const entries = (yield* listCanonicalWorkspaces(group.canonicalWorkspaceRoot)).filter(
      (entry) =>
        // A registration whose directory is gone has nothing on disk to
        // manage. Revival prunes it before recreating the path.
        !entry.prunable &&
        inside(managedWorktreesRoot, entry.path) &&
        !containsProjectRoot(entry.path, canonicalProjectRoots),
    );
    if (entries.length === 0) return [] as WorktreeInfo[];
    const defaultRef = yield* resolveDefaultRef(group.canonicalWorkspaceRoot);

    return yield* Effect.forEach(
      entries,
      (entry) =>
        Effect.gen(function* () {
          const usage = usageFor(entry.path);
          const inspection = yield* inspect(entry.path);
          const aheadOfDefaultCount = yield* aheadOfDefaultFor(entry.path, inspection, defaultRef);
          const blockers = removalBlockers({
            intent: "manual",
            inspection,
            aheadOfDefaultCount,
            usage,
            now,
          });
          // The same clock Storage cleanup ages a worktree by, so a pull
          // request refresh does not make it look recently used.
          const threadActivity =
            usage.threads.length === 0
              ? null
              : DateTime.formatIso(
                  DateTime.makeUnsafe(Math.max(...usage.threads.map(storageCleanupActivityAt))),
                );
          return {
            projectId: primaryProject.id,
            projectTitle: primaryProject.title,
            workspaceRoot: primaryProject.workspaceRoot,
            projects: group.projects.map((project) => ({
              projectId: project.id,
              projectTitle: project.title,
              workspaceRoot: project.workspaceRoot,
            })),
            path: entry.path,
            branch: inspection?.branch ?? entry.refName,
            headShortSha: (inspection?.headSha ?? entry.headCommit)?.slice(0, 7) ?? null,
            threads: usage.threads.map((thread) => ({
              threadId: thread.id,
              title: thread.title,
              status: threadStatus(thread),
            })),
            dirty: inspection === null ? null : inspection.changedFileCount > 0,
            dirtyFileCount: inspection?.changedFileCount ?? null,
            ignoredFileCount: inspection?.ignoredFiles.length ?? null,
            ignoredFiles: inspection?.ignoredFiles.slice(0, IGNORED_FILE_SAMPLE_SIZE) ?? [],
            hasUpstream: inspection === null ? null : inspection.upstream !== null,
            upstreamGone:
              inspection !== null &&
              inspection.upstream !== null &&
              inspection.aheadOfUpstreamCount === null,
            aheadOfUpstreamCount: inspection?.aheadOfUpstreamCount ?? null,
            behindUpstreamCount: inspection?.behindUpstreamCount ?? null,
            aheadOfDefaultCount,
            lastActivityAt: threadActivity ?? (yield* worktreeMtime(entry.path)),
            safeToPrune: blockers.length === 0,
            pruneBlockers: blockers,
          } satisfies WorktreeInfo;
        }),
      { concurrency: WORKTREE_STATUS_CONCURRENCY },
    );
  });

  const listWorktrees: WorktreeService["Service"]["listWorktrees"] = Effect.fn(
    "WorktreeService.listWorktrees",
  )(function* (input) {
    // Read first, so a change that lands while listing reports a newer revision.
    const revision = yield* lifecycle.revision;
    const projects = yield* readProjects.pipe(
      Effect.mapError((cause) => inventoryError("load_projects", cause)),
    );
    const usageFor = yield* readUsage().pipe(
      Effect.mapError((cause) => inventoryError("load_threads", cause)),
    );
    const now = yield* Clock.currentTimeMillis;

    const normalizedProjects = yield* Effect.forEach(
      projects,
      (project) =>
        Effect.gen(function* () {
          const canonicalWorkspaceRoot = yield* canonicalizePath(project.workspaceRoot);
          // A project outside any Git repository, or whose directory is gone,
          // has no worktrees to list; skip it rather than fail the inventory
          // for every other project.
          const commonDir = yield* executeLenient(
            "WorktreeService.listWorktrees.repositoryKey",
            canonicalWorkspaceRoot,
            ["rev-parse", "--git-common-dir"],
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("worktrees.inventory.repository-probe-failed", {
                projectId: project.id,
                workspaceRoot: canonicalWorkspaceRoot,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
          return {
            id: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
            canonicalWorkspaceRoot,
            repositoryKey:
              commonDir === null
                ? null
                : commonDir.trim().length === 0
                  ? canonicalWorkspaceRoot
                  : yield* canonicalizePath(path.resolve(canonicalWorkspaceRoot, commonDir.trim())),
          };
        }),
      { concurrency: PROJECT_SCAN_CONCURRENCY },
    );
    const canonicalProjectRoots = normalizedProjects.map(
      (project) => project.canonicalWorkspaceRoot,
    );
    const selectedRepositoryKeys =
      input.projectId === undefined
        ? null
        : new Set(
            normalizedProjects
              .filter((project) => project.id === input.projectId)
              .map((project) => project.repositoryKey),
          );

    // Projects sharing one repository list its worktrees once.
    const groups = new Map<string, ProjectGroup>();
    for (const project of normalizedProjects) {
      if (project.repositoryKey === null) continue;
      if (selectedRepositoryKeys !== null && !selectedRepositoryKeys.has(project.repositoryKey)) {
        continue;
      }
      const existing = groups.get(project.repositoryKey);
      groups.set(project.repositoryKey, {
        canonicalWorkspaceRoot: existing?.canonicalWorkspaceRoot ?? project.canonicalWorkspaceRoot,
        projects: [...(existing?.projects ?? []), project],
      });
    }

    const records = yield* Effect.forEach(
      [...groups.values()],
      (group) =>
        listGroup(group, usageFor, canonicalProjectRoots, now).pipe(
          Effect.mapError((cause) =>
            inventoryError("inspect_repository", cause, {
              workspaceRoot: group.canonicalWorkspaceRoot,
            }),
          ),
        ),
      { concurrency: PROJECT_SCAN_CONCURRENCY },
    );
    const worktrees = records.flat().toSorted((a, b) => {
      const aMs = a.lastActivityAt === null ? 0 : Date.parse(a.lastActivityAt);
      const bMs = b.lastActivityAt === null ? 0 : Date.parse(b.lastActivityAt);
      return aMs - bMs;
    });
    return { worktrees, revision };
  });

  const skipped = (reason: WorktreePruneSkipReason, detail?: string): RemovalOutcome => ({
    outcome: "skipped",
    reason,
    ...(detail === undefined ? {} : { detail }),
  });

  /**
   * Runs under the checkout's lease. Git state is read first, then threads,
   * sessions and terminals in one fresh read, then the policy recheck. The
   * checkout is inspected once more and the removal follows at once.
   * A turn that committed before the usage read is seen here.
   * One that commits after it waits on this lease in revival and recreates
   * the checkout from its branch.
   */
  const removeUnderLease = Effect.fn("WorktreeService.removeUnderLease")(function* (
    input: WorktreeRemovalInput,
    worktreePath: string,
  ) {
    const workspaceRoot = yield* canonicalizePath(input.workspaceRoot);
    if (!inside(managedWorktreesRoot, worktreePath) || !(yield* fs.exists(worktreePath))) {
      return skipped("protected_path");
    }
    const canonicalProjectRoots = yield* Effect.forEach(
      [{ workspaceRoot }, ...(yield* readProjects)],
      (project) => canonicalizePath(project.workspaceRoot),
    );
    if (containsProjectRoot(worktreePath, canonicalProjectRoots)) return skipped("protected_path");
    // A linked worktree has a .git file. Never remove a main checkout.
    if ((yield* fs.stat(path.join(worktreePath, ".git"))).type !== "File") {
      return skipped("protected_path");
    }
    const registration = (yield* listCanonicalWorkspaces(workspaceRoot)).find(
      (entry) => entry.path === worktreePath && !entry.prunable,
    );
    if (registration === undefined) return skipped("unknown_worktree");

    const inspection = yield* inspect(worktreePath);
    if (
      input.intent === "policy" &&
      inspection !== null &&
      (inspection.branch !== input.expected.branch || inspection.headSha !== input.expected.headSha)
    ) {
      return skipped("changed");
    }
    const aheadOfDefaultCount = yield* aheadOfDefaultFor(
      worktreePath,
      inspection,
      inspection === null ? null : yield* resolveDefaultRef(workspaceRoot),
    );

    const usage = (yield* readUsage())(worktreePath);
    const [blocker] = removalBlockers({
      intent: input.intent,
      inspection,
      aheadOfDefaultCount,
      usage,
      now: yield* Clock.currentTimeMillis,
    });
    if (blocker !== undefined) return skipped(blocker);
    if (
      (inspection?.ignoredFiles.length ?? 0) > 0 &&
      !(input.intent === "manual" && input.allowIgnoredFiles === true)
    ) {
      return skipped("ignored_files");
    }
    if (input.intent === "policy" && !(yield* input.recheck)) return skipped("policy_changed");
    // Every check above judged the first inspection, and the reads since then
    // took time. Another process may have switched the checkout, committed,
    // or written an ignored file meanwhile, and Git would delete that file
    // without complaint. So the checkout is inspected once more as the last
    // thing read before removal, and anything unreadable keeps it.
    if (inspection !== null) {
      const latest = yield* inspect(worktreePath);
      if (latest === null) return skipped("status_unavailable");
      if (latest.headSha !== inspection.headSha || latest.branch !== inspection.branch) {
        return skipped("changed");
      }
      if (latest.changedFileCount > 0) return skipped("dirty");
      if (
        latest.ignoredFiles.length > 0 &&
        !(input.intent === "manual" && input.allowIgnoredFiles === true)
      ) {
        return skipped("ignored_files");
      }
    }

    // A dropped connection must not stop Git halfway through deleting the
    // directory: what is left would pass for a healthy checkout on the next
    // turn. The revision advances with it, so no client keeps a removed row.
    const removal = yield* git
      .removeWorktree({ cwd: workspaceRoot, path: worktreePath, force: false })
      .pipe(
        Effect.tap(() => gitManager.invalidateStatus(input.workspaceRoot)),
        Effect.tap(() => lifecycle.markInventoryChanged),
        Effect.result,
        Effect.uninterruptible,
      );
    if (removal._tag === "Failure") return skipped("remove_failed", removal.failure.detail);
    return { outcome: "removed" } satisfies RemovalOutcome;
  });

  const removeIfSafe: WorktreeService["Service"]["removeIfSafe"] = Effect.fn(
    "WorktreeService.removeIfSafe",
  )(function* (input) {
    const worktreePath = yield* canonicalizePath(input.path);
    const outcome = yield* withWorkspaceLease(
      worktreePath,
      removeUnderLease(input, worktreePath),
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("worktrees.remove.check-failed", { worktreePath, cause }).pipe(
              Effect.as(skipped("status_unavailable")),
            ),
      ),
    );
    if (outcome.outcome === "removed") {
      yield* Effect.logInfo("worktrees.removed", { worktreePath, intent: input.intent });
    }
    return outcome;
  });

  const pruneWorktrees: WorktreeService["Service"]["pruneWorktrees"] = Effect.fn(
    "WorktreeService.pruneWorktrees",
  )(function* (input) {
    const [project] = yield* projectStore.listShells({ projectIds: [input.projectId] }).pipe(
      Effect.mapError(
        (cause) =>
          new WorktreeMutationError({
            operation: "prune",
            stage: "load_project",
            projectId: input.projectId,
            cause,
          }),
      ),
    );
    if (project === undefined) {
      return yield* new WorktreeMutationError({
        operation: "prune",
        stage: "project_not_found",
        projectId: input.projectId,
      });
    }
    const removed: Array<VcsPruneWorktreesResult["removed"][number]> = [];
    const skippedPaths: WorktreePruneSkip[] = [];
    // One lease per path, so a long request never holds up another checkout.
    // Results carry the canonical path, which is what inventory rows are keyed on.
    for (const worktreePath of new Set(yield* Effect.forEach(input.paths, canonicalizePath))) {
      const outcome = yield* removeIfSafe({
        path: worktreePath,
        workspaceRoot: project.workspaceRoot,
        intent: "manual",
        ...(input.allowIgnoredFiles === undefined
          ? {}
          : { allowIgnoredFiles: input.allowIgnoredFiles }),
      });
      if (outcome.outcome === "removed") {
        removed.push({ path: worktreePath, workspaceRoot: project.workspaceRoot });
      } else {
        skippedPaths.push({
          path: worktreePath,
          reason: outcome.reason,
          ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        });
      }
    }
    return { removed, skipped: skippedPaths };
  });

  const removeWorktree: WorktreeService["Service"]["removeWorktree"] = Effect.fn(
    "WorktreeService.removeWorktree",
  )(function* (input) {
    const outcome = yield* removeIfSafe({
      path: input.path,
      workspaceRoot: input.cwd,
      intent: "manual",
    });
    if (outcome.outcome === "skipped") {
      return yield* new WorktreeRemovalSkippedError({
        path: input.path,
        reason: outcome.reason,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      });
    }
  });

  return WorktreeService.of({ listWorktrees, pruneWorktrees, removeWorktree, removeIfSafe });
});

export const layer = Layer.effect(WorktreeService, make);
