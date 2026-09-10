// @effect-diagnostics nodeBuiltinImport:off - cleanup verifies local Git worktrees and their configured remotes.
// @effect-diagnostics globalDate:off - the scheduler compares persisted ISO activity timestamps.
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  AgentDashboardRepositoryPolicy,
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
} from "@t3tools/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as AgentDashboardRunHistory from "./AgentDashboardRunHistory.ts";
import * as AgentDashboardStore from "./AgentDashboardStore.ts";

const AUTOMATION_KIND = "inactive-worktree-cleanup";
const DAY_MS = 24 * 60 * 60 * 1_000;
const POLL_INTERVAL = Duration.seconds(30);

interface GitCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
}

export interface InactiveWorktreeCandidate {
  readonly project: OrchestrationProjectShell;
  readonly path: string;
  readonly lastActivityAt: string;
}

export interface WorktreeRemoteSafety {
  readonly registered: boolean;
  readonly clean: boolean;
  readonly branch: string | null;
  readonly remoteName: string | null;
  readonly upstream: string | null;
  readonly headSavedOnRemote: boolean;
  readonly lastCommitAtMs: number | null;
}

export class AgentDashboardInactiveWorktreeCleanupError extends Schema.TaggedError<AgentDashboardInactiveWorktreeCleanupError>()(
  "AgentDashboardInactiveWorktreeCleanupError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface AgentDashboardInactiveWorktreeCleanupService {
  /** Runs one due cleanup scan. Null means disabled or not yet due. */
  readonly runOnce: Effect.Effect<number | null, AgentDashboardInactiveWorktreeCleanupError>;
}

export class AgentDashboardInactiveWorktreeCleanup extends Context.Service<
  AgentDashboardInactiveWorktreeCleanup,
  AgentDashboardInactiveWorktreeCleanupService
>()("t3/agentDashboard/AgentDashboardInactiveWorktreeCleanup") {}

const threadIsActive = (thread: OrchestrationThreadShell): boolean =>
  thread.latestTurn?.state === "running" ||
  thread.session?.status === "starting" ||
  thread.session?.status === "running" ||
  thread.backgroundLiveness != null ||
  thread.hasPendingApprovals ||
  thread.hasPendingUserInput;

const threadActivityMs = (thread: OrchestrationThreadShell): number =>
  Math.max(
    Date.parse(thread.updatedAt),
    Date.parse(thread.session?.updatedAt ?? thread.updatedAt),
    Date.parse(
      thread.latestTurn?.completedAt ??
        thread.latestTurn?.startedAt ??
        thread.latestTurn?.requestedAt ??
        thread.updatedAt,
    ),
  );

export const selectInactiveWorktreeCandidates = (input: {
  readonly snapshot: OrchestrationShellSnapshot;
  readonly policies: ReadonlyArray<AgentDashboardRepositoryPolicy>;
  readonly cutoffMs: number;
}): ReadonlyArray<InactiveWorktreeCandidate> => {
  const projects = new Map(input.snapshot.projects.map((project) => [String(project.id), project]));
  const threadsByWorktree = new Map<string, Array<OrchestrationThreadShell>>();
  for (const thread of input.snapshot.threads) {
    if (thread.worktreePath === null) continue;
    const project = projects.get(String(thread.projectId));
    if (
      project === undefined ||
      NodePath.resolve(thread.worktreePath) === NodePath.resolve(project.workspaceRoot)
    ) {
      continue;
    }
    const existing = threadsByWorktree.get(thread.worktreePath) ?? [];
    existing.push(thread);
    threadsByWorktree.set(thread.worktreePath, existing);
  }

  return Array.from(threadsByWorktree, ([path, threads]) => {
    const project = projects.get(String(threads[0]?.projectId));
    if (project === undefined) return null;
    const lastActivityMs = Math.max(...threads.map(threadActivityMs));
    if (
      threads.some(threadIsActive) ||
      threads.some((thread) => thread.settledAt === null) ||
      lastActivityMs > input.cutoffMs ||
      !AgentDashboardStore.repositoryAutomationsEnabled(input.policies, project.id, AUTOMATION_KIND)
    ) {
      return null;
    }
    return {
      project,
      path,
      lastActivityAt: new Date(lastActivityMs).toISOString(),
    } satisfies InactiveWorktreeCandidate;
  })
    .filter((candidate): candidate is InactiveWorktreeCandidate => candidate !== null)
    .toSorted(
      (left, right) =>
        left.lastActivityAt.localeCompare(right.lastActivityAt) ||
        left.path.localeCompare(right.path),
    );
};

const runGit = (cwd: string, args: ReadonlyArray<string>): Promise<GitCommandResult> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      "git",
      ["-C", cwd, ...args],
      { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000 },
      (error, stdout) => {
        resolve({
          exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : null,
          stdout: typeof stdout === "string" ? stdout : "",
        });
      },
    );
  });

const outputOrNull = async (cwd: string, args: ReadonlyArray<string>): Promise<string | null> => {
  const result = await runGit(cwd, args);
  if (result.exitCode !== 0) return null;
  const output = result.stdout.trim();
  return output.length > 0 ? output : null;
};

const resolveGitPath = (cwd: string, value: string): string => NodePath.resolve(cwd, value);

export const inspectWorktreeRemoteSafety = async (input: {
  readonly repositoryRoot: string;
  readonly worktreePath: string;
}): Promise<WorktreeRemoteSafety> => {
  const [repositoryRoot, worktreePath] = await Promise.all([
    NodeFSP.realpath(input.repositoryRoot),
    NodeFSP.realpath(input.worktreePath),
  ]);
  const [rootCommonDirectory, worktreeCommonDirectory, worktreeTopLevel, worktreeList] =
    await Promise.all([
      outputOrNull(repositoryRoot, ["rev-parse", "--git-common-dir"]),
      outputOrNull(worktreePath, ["rev-parse", "--git-common-dir"]),
      outputOrNull(worktreePath, ["rev-parse", "--show-toplevel"]),
      outputOrNull(repositoryRoot, ["worktree", "list", "--porcelain"]),
    ]);
  const listedPaths = new Set(
    (worktreeList ?? "")
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => NodePath.resolve(line.slice("worktree ".length))),
  );
  const registered =
    rootCommonDirectory !== null &&
    worktreeCommonDirectory !== null &&
    worktreeTopLevel !== null &&
    resolveGitPath(repositoryRoot, rootCommonDirectory) ===
      resolveGitPath(worktreePath, worktreeCommonDirectory) &&
    NodePath.resolve(worktreeTopLevel) === worktreePath &&
    listedPaths.has(worktreePath);

  const status = await runGit(worktreePath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  const clean = status.exitCode === 0 && status.stdout.trim().length === 0;
  const branch = await outputOrNull(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const remoteName =
    branch === null
      ? null
      : await outputOrNull(worktreePath, ["config", "--get", `branch.${branch}.remote`]);
  const remoteBranchRef =
    branch === null
      ? null
      : await outputOrNull(worktreePath, ["config", "--get", `branch.${branch}.merge`]);
  const upstream = await outputOrNull(worktreePath, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
  const lastCommitSeconds = await outputOrNull(worktreePath, [
    "show",
    "-s",
    "--format=%ct",
    "HEAD",
  ]);
  const remoteHead =
    remoteName === null || remoteName === "." || remoteBranchRef === null
      ? null
      : await outputOrNull(worktreePath, [
          "ls-remote",
          "--exit-code",
          "--heads",
          remoteName,
          remoteBranchRef,
        ]);
  const remoteHeadSha = remoteHead?.split(/\s+/, 1)[0] ?? null;
  const containsHead =
    remoteHeadSha === null
      ? { exitCode: null }
      : await runGit(worktreePath, ["merge-base", "--is-ancestor", "HEAD", remoteHeadSha]);

  return {
    registered,
    clean,
    branch,
    remoteName: remoteName === "." ? null : remoteName,
    upstream,
    headSavedOnRemote:
      upstream !== null &&
      remoteBranchRef?.startsWith("refs/heads/") === true &&
      containsHead.exitCode === 0,
    lastCommitAtMs:
      lastCommitSeconds !== null && Number.isFinite(Number(lastCommitSeconds))
        ? Number(lastCommitSeconds) * 1_000
        : null,
  };
};

const make = Effect.gen(function* () {
  const dashboardStore = yield* AgentDashboardStore.AgentDashboardStore;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const history = yield* AgentDashboardRunHistory.AgentDashboardRunHistory;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const lastRunAt = yield* Ref.make<number | null>(null);

  const runOnce: AgentDashboardInactiveWorktreeCleanupService["runOnce"] = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.map((current) => current.inactiveWorktreeCleanup),
      Effect.mapError(
        (cause) =>
          new AgentDashboardInactiveWorktreeCleanupError({
            operation: "read settings",
            message: "T3 could not read the inactive worktree cleanup settings.",
            cause,
          }),
      ),
    );
    if (!settings.enabled) return null;

    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const previousRunAt = yield* Ref.get(lastRunAt);
    if (previousRunAt !== null && nowMs - previousRunAt < settings.intervalDays * DAY_MS) {
      return null;
    }

    const [snapshot, policies] = yield* Effect.all([
      projection.getShellSnapshot(),
      dashboardStore.readRepositoryPolicies,
    ]).pipe(
      Effect.mapError(
        (cause) =>
          new AgentDashboardInactiveWorktreeCleanupError({
            operation: "read portfolio",
            message: "T3 could not read projects and repository automation policies.",
            cause,
          }),
      ),
    );
    const cutoffMs = nowMs - settings.minimumInactiveDays * DAY_MS;
    const candidates = selectInactiveWorktreeCandidates({ snapshot, policies, cutoffMs });
    let removed = 0;
    yield* Effect.forEach(
      candidates,
      (candidate) =>
        Effect.gen(function* () {
          const preflight = yield* Effect.tryPromise({
            try: () =>
              inspectWorktreeRemoteSafety({
                repositoryRoot: candidate.project.workspaceRoot,
                worktreePath: candidate.path,
              }),
            catch: (cause) =>
              new AgentDashboardInactiveWorktreeCleanupError({
                operation: "inspect worktree",
                message: "T3 could not inspect the inactive worktree safely.",
                cause,
              }),
          });
          if (preflight.remoteName === null) return;
          yield* git.fetchRemote({
            cwd: candidate.path,
            remoteName: preflight.remoteName,
          });
          const verified = yield* Effect.tryPromise({
            try: () =>
              inspectWorktreeRemoteSafety({
                repositoryRoot: candidate.project.workspaceRoot,
                worktreePath: candidate.path,
              }),
            catch: (cause) =>
              new AgentDashboardInactiveWorktreeCleanupError({
                operation: "verify worktree",
                message: "T3 could not verify the inactive worktree after fetching its remote.",
                cause,
              }),
          });
          if (
            !verified.registered ||
            !verified.clean ||
            verified.branch === null ||
            verified.remoteName === null ||
            verified.upstream === null ||
            !verified.headSavedOnRemote ||
            verified.lastCommitAtMs === null ||
            verified.lastCommitAtMs > cutoffMs
          ) {
            return;
          }
          yield* git.removeWorktree({
            cwd: candidate.project.workspaceRoot,
            path: candidate.path,
            forceIfClean: true,
          });
          removed += 1;
          const completedAt = DateTime.formatIso(yield* DateTime.now);
          yield* history.upsert({
            id: `${AUTOMATION_KIND}:${String(candidate.project.id)}:${nowMs}:${removed}`,
            status: "succeeded",
            trigger: "scheduled",
            kind: AUTOMATION_KIND,
            repository: { projectId: candidate.project.id },
            target: candidate.path,
            threadId: null,
            jobId: null,
            model: null,
            retryCount: 0,
            findingCount: 0,
            costUnits: null,
            error: null,
            createdAt: completedAt,
            startedAt: completedAt,
            updatedAt: completedAt,
            completedAt,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Inactive worktree cleanup skipped a candidate", {
              projectId: candidate.project.id,
              worktreePath: candidate.path,
              cause,
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
    yield* Ref.set(lastRunAt, nowMs);
    return removed;
  });

  const tick = runOnce.pipe(
    Effect.tap((removed) =>
      removed === null
        ? Effect.void
        : Effect.logInfo("Inactive worktree cleanup scan completed", { removed }),
    ),
    Effect.catchCause((cause) =>
      Effect.logError("Inactive worktree cleanup scheduler tick failed", { cause }),
    ),
    Effect.asVoid,
  );
  yield* Effect.forkScoped(
    startup.awaitCommandReady.pipe(
      Effect.andThen(tick.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL)))),
      Effect.catchCause((cause) =>
        Effect.logError("Inactive worktree cleanup could not reach command readiness", { cause }),
      ),
    ),
  );

  return { runOnce } satisfies AgentDashboardInactiveWorktreeCleanupService;
});

export const layer = Layer.effect(AgentDashboardInactiveWorktreeCleanup, make);
