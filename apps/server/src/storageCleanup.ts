import { OrchestrationV2AppThreadJson } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type {
  ProjectId,
  ServerSettings,
  ServerSettingsError,
  WorktreeCleanupRules,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import { forkParked } from "./serverActivation.ts";
import * as Settings from "./serverSettings.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as WorktreeService from "./vcs/WorktreeService.ts";
import { storageCleanupActivityAt, storageCleanupThreadIdle } from "./vcs/worktreeThreadState.ts";

const decodeCleanupThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);

const DAY_MS = 86_400_000;

const worktreeCleanupEnabled = (rules: WorktreeCleanupRules) =>
  rules.worktreeAfterDays !== null ||
  rules.worktreeOnMerge ||
  rules.worktreeOnDelete ||
  rules.worktreeUnchanged;

function anyWorktreePolicy(
  settings: ServerSettings,
  predicate: (rules: WorktreeCleanupRules) => boolean,
): boolean {
  return (
    predicate(resolveWorktreeCleanup(settings, null)) ||
    Object.keys(settings.projectSettingsOverrides).some((projectId) =>
      predicate(resolveWorktreeCleanup(settings, projectId as ProjectId)),
    )
  );
}

function sameProjectWorktreePolicies(left: ServerSettings, right: ServerSettings): boolean {
  return [
    ...new Set([
      ...Object.keys(left.projectSettingsOverrides),
      ...Object.keys(right.projectSettingsOverrides),
    ]),
  ].every((projectId) =>
    Equal.equals(
      left.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
      right.projectSettingsOverrides[projectId as ProjectId]?.worktreeCleanup,
    ),
  );
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const worktrees = yield* WorktreeService.WorktreeService;
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
  const readThreads = Effect.fn("StorageCleanup.readThreads")(function* () {
    const active = yield* projections.getShellSnapshot();
    const archived = yield* projections.getShellSnapshot({ location: "archive" });
    const projects = yield* projectStore.listShells();
    return { projects, threads: [...active.threads, ...archived.threads] };
  });

  const cleanWorktrees = Effect.fn("StorageCleanup.cleanWorktrees")(function* (
    serverSettings: ServerSettings,
    now: number,
  ) {
    if (!anyWorktreePolicy(serverSettings, worktreeCleanupEnabled)) return;
    if (!(yield* fs.exists(config.worktreesDir))) return;
    const hasDeleteRule = anyWorktreePolicy(serverSettings, (rules) => rules.worktreeOnDelete);
    const deletedRows = hasDeleteRule
      ? yield* sql<{ payload_json: string; workspaceRoot: string }>`
          SELECT t.payload_json, p.workspace_root AS "workspaceRoot"
          FROM orchestration_v2_projection_threads t
          JOIN projection_projects p ON p.project_id = t.project_id
          WHERE t.deleted_at IS NOT NULL
        `
      : [];
    const deletedThreads = (yield* Effect.forEach(deletedRows, (row) =>
      decodeCleanupThread(row.payload_json).pipe(
        Effect.map((thread) => ({ ...thread, workspaceRoot: row.workspaceRoot })),
      ),
    )).filter(
      (thread) =>
        thread.worktreePath !== null &&
        thread.branch !== null &&
        resolveWorktreeCleanup(serverSettings, thread.projectId).worktreeOnDelete,
    );
    const snapshot = yield* readThreads();
    const root = yield* fs.realPath(config.worktreesDir);
    const refreshedDefaultRefs = new Map<string, Set<string>>();
    const groups = Map.groupBy(
      snapshot.threads.filter((thread) => thread.worktreePath !== null),
      (thread) => path.resolve(thread.worktreePath!),
    );
    const candidates = [
      ...[...groups.values()].flatMap((group) => (group.length === 1 ? [group[0]!] : [])),
      ...deletedThreads.filter((thread) => !groups.has(path.resolve(thread.worktreePath!))),
    ];
    for (const thread of candidates) {
      const settings = resolveWorktreeCleanup(serverSettings, thread.projectId);
      if (!worktreeCleanupEnabled(settings)) continue;
      const worktreePath = path.resolve(thread.worktreePath!);
      const deleted = "workspaceRoot" in thread;
      const project = deleted
        ? { workspaceRoot: thread.workspaceRoot }
        : snapshot.projects.find((entry) => entry.id === thread.projectId);
      const branch = thread.branch;
      if (
        project === undefined ||
        branch === null ||
        (!deleted && !storageCleanupThreadIdle(thread, now))
      )
        continue;
      // This service decides which worktree a rule applies to. Whether the
      // checkout can go at all (its path, sessions, terminals, running turns,
      // changed and ignored files) is WorktreeService's decision, made under
      // the checkout's lease. Fetches and host lookups stay out here.
      yield* Effect.gen(function* () {
        if (!inside(root, worktreePath) || !(yield* fs.exists(worktreePath))) return;
        const status = yield* git.statusDetailsLocal(worktreePath);
        if (!status.isRepo || status.branch !== branch || status.hasWorkingTreeChanges) return;
        const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
        const old =
          !deleted &&
          settings.worktreeAfterDays !== null &&
          storageCleanupActivityAt(thread) < now - settings.worktreeAfterDays * DAY_MS;
        let eligible = deleted || old;
        if (!eligible && (settings.worktreeUnchanged || settings.worktreeOnMerge)) {
          const repositoryCwd = path.resolve(project.workspaceRoot);
          const remote = yield* git.resolvePrimaryRemoteName(repositoryCwd);
          const defaultBranch = yield* git.resolveDefaultBranchName(repositoryCwd, remote);
          if (defaultBranch === null) return;
          const defaultRef = `refs/remotes/${remote}/${defaultBranch}`;
          const refreshed = refreshedDefaultRefs.get(repositoryCwd) ?? new Set<string>();
          if (!refreshed.has(defaultRef)) {
            yield* git.fetchRemoteTrackingBranch({
              cwd: repositoryCwd,
              remoteName: remote,
              remoteBranch: defaultBranch,
            });
            refreshed.add(defaultRef);
            refreshedDefaultRefs.set(repositoryCwd, refreshed);
          }
          const base = yield* git.resolveCommit({
            cwd: worktreePath,
            revision: defaultRef,
          });
          const ancestor = yield* git.execute({
            operation: "StorageCleanup.integratedBranch",
            cwd: worktreePath,
            args: ["merge-base", "--is-ancestor", head.commitSha, base.commitSha],
            allowNonZeroExit: true,
          });
          if (ancestor.exitCode !== 0) return;
          eligible = settings.worktreeUnchanged;
          if (!eligible && settings.worktreeOnMerge) {
            const pullRequest = yield* gitManager.branchPullRequest(
              { cwd: worktreePath, branch },
              { refresh: true },
            );
            eligible = pullRequest?.state === "merged";
          }
        }
        if (!eligible) return;
        // Runs under the lease, after the Git and host calls above, so a new
        // thread sharing this path, fresh activity or a changed rule cancels
        // the removal.
        const stillApplies = Effect.gen(function* () {
          const latest = (yield* readThreads()).threads.filter(
            (entry) =>
              entry.worktreePath !== null && path.resolve(entry.worktreePath) === worktreePath,
          );
          if (deleted) {
            if (latest.length > 0) return false;
            // V2 deletion queues durable cleanup. Do not remove its checkout until
            // every effect has finished successfully or was explicitly cancelled.
            const pendingCleanup = yield* sql`
              SELECT 1 FROM orchestration_v2_effect_outbox
              WHERE thread_id = ${thread.id} AND status NOT IN ('succeeded', 'cancelled') LIMIT 1
            `;
            if (pendingCleanup.length > 0) return false;
          } else if (
            latest.length !== 1 ||
            latest[0]!.id !== thread.id ||
            !storageCleanupThreadIdle(latest[0]!, now) ||
            storageCleanupActivityAt(latest[0]!) !== storageCleanupActivityAt(thread)
          ) {
            return false;
          }
          const current = resolveWorktreeCleanup(
            yield* settingsService.getSettings,
            thread.projectId,
          );
          return Object.keys(settings).every(
            (key) =>
              current[key as keyof typeof settings] === settings[key as keyof typeof settings],
          );
        }).pipe(
          Effect.catch((error) =>
            Effect.logDebug("storage cleanup recheck failed", { threadId: thread.id, error }).pipe(
              Effect.as(false),
            ),
          ),
        );
        // The branch and path are kept: WorktreeRevivalService recreates the
        // checkout from that branch before the thread's next turn.
        const outcome = yield* worktrees.removeIfSafe({
          path: worktreePath,
          workspaceRoot: project.workspaceRoot,
          intent: "policy",
          expected: { branch, headSha: head.commitSha },
          recheck: stillApplies,
        });
        yield* outcome.outcome === "removed"
          ? Effect.logInfo("storage cleanup removed worktree", { threadId: thread.id })
          : Effect.logDebug("storage cleanup kept worktree", {
              threadId: thread.id,
              reason: outcome.reason,
            });
      }).pipe(
        Effect.catch((error) =>
          Effect.logDebug("storage cleanup skipped worktree", { threadId: thread.id, error }),
        ),
      );
    }
  });

  const cleanFiles = Effect.fn("StorageCleanup.cleanFiles")(function* (
    root: string,
    days: number | null,
    now: number,
    rotatedLogs: boolean,
  ) {
    if (days === null || !(yield* fs.exists(root))) return;
    const realRoot = yield* fs.realPath(root);
    if (realRoot !== path.resolve(root)) return;
    const visit = Effect.fn("StorageCleanup.visitFiles")(function* (
      directory: string,
    ): Effect.fn.Return<void, PlatformError | ServerSettingsError> {
      for (const name of yield* fs.readDirectory(directory)) {
        const target = path.join(directory, name);
        if ((yield* fs.realPath(target)) !== target || !inside(realRoot, target)) continue;
        const stat = yield* fs.stat(target);
        if (stat.type === "Directory" && rotatedLogs) {
          yield* visit(target);
        } else if (stat.type === "File" && (!rotatedLogs || /\.(?:log|ndjson)\.\d+$/.test(name))) {
          const modified = Option.getOrNull(stat.mtime);
          if (modified !== null && modified.getTime() < now - days * DAY_MS) {
            const current = (yield* settingsService.getSettings).storageCleanup;
            if ((rotatedLogs ? current.logsAfterDays : current.browserArtifactsAfterDays) !== days)
              return;
            yield* fs.remove(target);
          }
        }
      }
    });
    yield* visit(realRoot);
  });

  const sweep = Effect.fn("StorageCleanup.sweep")(function* () {
    const serverSettings = yield* settingsService.getSettings;
    const settings = serverSettings.storageCleanup;
    const now = yield* Clock.currentTimeMillis;
    yield* cleanWorktrees(serverSettings, now).pipe(
      Effect.catch((error) => Effect.logWarning("worktree cleanup failed", { error })),
    );
    yield* cleanFiles(
      config.browserArtifactsDir,
      settings.browserArtifactsAfterDays,
      now,
      false,
    ).pipe(
      Effect.catch((error) => Effect.logWarning("browser artifact cleanup failed", { error })),
    );
    yield* cleanFiles(config.logsDir, settings.logsAfterDays, now, true).pipe(
      Effect.catch((error) => Effect.logWarning("rotated log cleanup failed", { error })),
    );
  });
  const worker = yield* makeDrainableWorker(() =>
    sweep().pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("storage cleanup failed", { cause }),
      ),
    ),
  );

  const start = Effect.fn("StorageCleanup.start")(function* () {
    const changes = yield* settingsService.subscribeChanges;
    const events = engine.streamDomainEvents;
    let lastSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    yield* forkParked(
      worker
        .enqueue(undefined)
        .pipe(
          Effect.andThen(worker.drain),
          Effect.repeat(Schedule.spaced("1 hour")),
          Effect.asVoid,
        ),
    );
    yield* forkParked(
      Stream.runForEach(changes, (settings) => {
        if (
          Equal.equals(settings.storageCleanup, lastSettings.storageCleanup) &&
          Equal.equals(settings.worktreeCleanup, lastSettings.worktreeCleanup) &&
          sameProjectWorktreePolicies(settings, lastSettings)
        )
          return Effect.void;
        lastSettings = settings;
        return worker.enqueue(undefined);
      }),
    );
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        (event.type === "thread.deleted" || event.type === "provider-session.updated") &&
        anyWorktreePolicy(lastSettings, (rules) => rules.worktreeOnDelete)
          ? worker.enqueue(undefined)
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Storage cleanup event stream failed", { cause }),
        ),
      ),
    );
  });
  return { start, drain: worker.drain };
});
