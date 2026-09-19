import type {
  OrchestrationThreadShell,
  ProjectId,
  ServerSettings,
  ServerSettingsError,
  TerminalSummary,
  WorktreeCleanupRules,
  StorageCleanupPreview,
  StorageCleanupPreviewInput,
  StorageCleanupCategory,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import { measureWorktreeBytes } from "./storageCleanupSize.ts";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ThreadDeletionReactor from "./orchestration/Services/ThreadDeletionReactor.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import { threadHasQueuedTurnStart } from "./orchestration/ThreadSettlementPolicy.ts";
import { forkParked } from "./serverActivation.ts";
import * as Settings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "./workspace/workspaceLease.ts";

export class StorageCleanup extends Context.Service<
  StorageCleanup,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    readonly revisions: Stream.Stream<number>;
    readonly preview: (
      input: StorageCleanupPreviewInput,
    ) => Effect.Effect<StorageCleanupPreview, ServerSettingsError>;
  }
>()("t3/storageCleanup") {}

interface PreviewFolder {
  projectId: ProjectId;
  path: string;
  category: StorageCleanupCategory;
  bytes: number | null;
}

interface PreviewScan {
  readonly input: StorageCleanupPreviewInput;
  total: number;
  checked: number;
  unavailable: number;
  readonly folders: PreviewFolder[];
}

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

/** Live sessions keep their cwd even when no turn is currently running. */
function storageCleanupThreadIdle(thread: OrchestrationThreadShell, now: number): boolean {
  return (
    thread.branch !== null &&
    thread.worktreePath !== null &&
    (thread.session === null || thread.session.status === "stopped") &&
    thread.latestTurn?.state !== "running" &&
    thread.backgroundLiveness == null &&
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput &&
    !threadHasQueuedTurnStart(thread, DateTime.formatIso(DateTime.makeUnsafe(now)))
  );
}

/** PR metadata refreshes must not reset the inactivity clock. */
function storageCleanupActivityAt(thread: OrchestrationThreadShell): number {
  return Math.max(
    ...[
      thread.createdAt,
      thread.latestUserMessageAt,
      thread.latestTurn?.requestedAt,
      thread.latestTurn?.startedAt,
      thread.latestTurn?.completedAt,
    ].flatMap((value) => (value == null ? [] : [Date.parse(value)])),
  );
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const threadDeletion = yield* ThreadDeletionReactor.ThreadDeletionReactor;
  const providers = yield* ProviderService.ProviderService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitManager = yield* GitManager.GitManager;
  const terminals = yield* TerminalManager.TerminalManager;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const liveTerminals = new Map<string, Map<string, TerminalSummary>>();
  const noteTerminal = (terminal: TerminalSummary) => {
    const threadTerminals =
      liveTerminals.get(terminal.threadId) ?? new Map<string, TerminalSummary>();
    threadTerminals.set(terminal.terminalId, terminal);
    liveTerminals.set(terminal.threadId, threadTerminals);
  };

  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const hasTerminal = (worktreePath: string) =>
    [...liveTerminals.values()]
      .flatMap((entries) => [...entries.values()])
      .some((terminal) => {
        if (terminal.status !== "starting" && terminal.status !== "running") return false;
        const cwd = path.resolve(terminal.cwd);
        return (
          (terminal.worktreePath !== null &&
            path.resolve(terminal.worktreePath) === worktreePath) ||
          cwd === worktreePath ||
          inside(worktreePath, cwd)
        );
      });

  const readThreads = Effect.fn("StorageCleanup.readThreads")(function* () {
    const active = yield* snapshots.getShellSnapshot();
    const archived = yield* snapshots.getArchivedShellSnapshot();
    return { projects: active.projects, threads: [...active.threads, ...archived.threads] };
  });

  // Local threads under another project need not have a worktreePath of their own.
  const containsProjectRoot = Effect.fn("StorageCleanup.containsProjectRoot")(function* (
    worktreePath: string,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
    realPaths?: Map<string, string>,
  ) {
    for (const project of projects) {
      const projectPath = path.resolve(project.workspaceRoot);
      if (projectPath === worktreePath || inside(worktreePath, projectPath)) return true;
      const realPath =
        realPaths?.get(projectPath) ??
        (yield* fs.realPath(projectPath).pipe(Effect.orElseSucceed(() => projectPath)));
      realPaths?.set(projectPath, realPath);
      if (realPath === worktreePath || inside(worktreePath, realPath)) return true;
    }
    return false;
  });

  const cleanWorktrees = Effect.fn("StorageCleanup.cleanWorktrees")(function* (
    serverSettings: ServerSettings,
    now: number,
    preview?: PreviewScan,
  ) {
    if (!anyWorktreePolicy(serverSettings, worktreeCleanupEnabled)) return;
    if (!(yield* fs.exists(config.worktreesDir))) return;
    const hasDeleteRule = anyWorktreePolicy(serverSettings, (rules) => rules.worktreeOnDelete);
    const deletedThreads = hasDeleteRule
      ? (yield* snapshots.getDeletedWorktreeThreads()).filter(
          (thread) => resolveWorktreeCleanup(serverSettings, thread.projectId).worktreeOnDelete,
        )
      : [];
    if (deletedThreads.length > 0 && !preview) {
      // Read tombstones before taking this fence. A later deletion waits for the
      // next sweep; every captured deletion must finish stopping its resources.
      const { snapshotSequence } = yield* snapshots.getSnapshotSequence();
      yield* threadDeletion.drainThrough(snapshotSequence);
    }
    const snapshot = yield* readThreads();
    const root = yield* fs.realPath(config.worktreesDir);
    const previewRealPaths = preview ? new Map<string, string>() : undefined;
    const projectsById = new Map(snapshot.projects.map((project) => [project.id, project]));
    const refreshedDefaultRefs = new Map<string, Set<string>>();
    const groups = Map.groupBy(
      snapshot.threads.filter((thread) => thread.worktreePath !== null),
      (thread) => path.resolve(thread.worktreePath!),
    );
    const candidates = [
      ...[...groups.values()].flatMap((group) => {
        if (!preview) return group.length === 1 ? [group[0]!] : [];
        const candidate = preview.input.projectId
          ? group.find((thread) => thread.projectId === preview.input.projectId)
          : group[0];
        return candidate ? [candidate] : [];
      }),
      ...deletedThreads.filter((thread) => !groups.has(path.resolve(thread.worktreePath))),
    ];
    const seen = new Set<string>();
    const scopedCandidates = candidates.filter((thread) => {
      if (!preview) return true;
      if (preview.input.projectId && thread.projectId !== preview.input.projectId) return false;
      const folder = path.resolve(thread.worktreePath!);
      if (seen.has(folder)) return false;
      seen.add(folder);
      return true;
    });
    if (preview) preview.total = scopedCandidates.length;
    for (const thread of scopedCandidates) {
      if (preview && (yield* Clock.currentTimeMillis) - now >= 10_000) break;
      const settings = resolveWorktreeCleanup(serverSettings, thread.projectId);
      if (!worktreeCleanupEnabled(settings)) {
        if (preview) preview.checked++;
        continue;
      }
      const worktreePath = path.resolve(thread.worktreePath!);
      const deleted = "deletedAt" in thread;
      const project = deleted
        ? { workspaceRoot: thread.workspaceRoot }
        : projectsById.get(thread.projectId);
      const old =
        !deleted &&
        settings.worktreeAfterDays !== null &&
        storageCleanupActivityAt(thread) < now - settings.worktreeAfterDays * DAY_MS;
      const protectedWorktree =
        project === undefined ||
        (!deleted && !storageCleanupThreadIdle(thread, now)) ||
        hasTerminal(worktreePath) ||
        (groups.get(worktreePath)?.length ?? 0) > 1;
      if (
        !preview &&
        (protectedWorktree ||
          (!deleted && !old && !settings.worktreeUnchanged && !settings.worktreeOnMerge))
      ) {
        continue;
      }
      let previewFolder: PreviewFolder | undefined;
      yield* Effect.gen(function* () {
        if (!inside(root, worktreePath) || !(yield* fs.exists(worktreePath))) return;
        if ((yield* fs.realPath(worktreePath)) !== worktreePath) return;
        // A linked worktree has a .git file. Never remove a main checkout.
        if ((yield* fs.stat(path.join(worktreePath, ".git"))).type !== "File") return;
        if (preview) {
          previewFolder = {
            projectId: thread.projectId,
            path: worktreePath,
            category: "kept",
            bytes: null,
          };
          preview.folders.push(previewFolder);
        }
        if (protectedWorktree || project === undefined) return;
        if (
          yield* containsProjectRoot(
            worktreePath,
            [project, ...snapshot.projects],
            previewRealPaths,
          )
        )
          return;
        const status = yield* git.statusDetailsLocal(worktreePath);
        if (!status.isRepo || status.branch !== thread.branch || status.hasWorkingTreeChanges)
          return;
        const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
        const ignored = yield* git.execute({
          operation: "StorageCleanup.ignoredFiles",
          cwd: worktreePath,
          args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
          maxOutputBytes: 64 * 1024,
        });
        // Ignored files can contain secrets or local datasets. Dependency installs
        // are reproducible; every other ignored path prevents automatic removal.
        if (
          ignored.stdoutTruncated ||
          ignored.stdout
            .split("\0")
            .some((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry))
        )
          return;
        let category: StorageCleanupCategory = deleted ? "deleted" : old ? "inactive" : "kept";
        let eligible = deleted || old;
        if (!eligible && (settings.worktreeUnchanged || settings.worktreeOnMerge)) {
          const repositoryCwd = path.resolve(project.workspaceRoot);
          const remote = yield* git.resolvePrimaryRemoteName(repositoryCwd);
          const branch = yield* git.resolveDefaultBranchName(repositoryCwd, remote);
          if (branch === null) return;
          const defaultRef = `refs/remotes/${remote}/${branch}`;
          const refreshed = refreshedDefaultRefs.get(repositoryCwd) ?? new Set<string>();
          if (!preview && !refreshed.has(defaultRef)) {
            yield* git.fetchRemoteTrackingBranch({
              cwd: repositoryCwd,
              remoteName: remote,
              remoteBranch: branch,
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
          if (preview && eligible) {
            // Preview uses already-synced PR metadata; opening Settings must not query every forge.
            category =
              !deleted &&
              thread.pullRequests.some(
                (pr) => pr.snapshot?.state === "merged" && pr.snapshot.headBranch === thread.branch,
              )
                ? "merged"
                : "unchanged";
          }
          if (!eligible && settings.worktreeOnMerge && thread.branch !== null) {
            const pullRequest = yield* gitManager.branchPullRequest(
              { cwd: worktreePath, branch: thread.branch },
              { refresh: true },
            );
            eligible = pullRequest?.state === "merged";
          }
        }
        if (!eligible) return;
        if (preview) {
          if (
            deleted &&
            (yield* providers.listSessions()).some(
              (session) =>
                session.status !== "closed" &&
                (session.threadId === thread.id ||
                  (session.cwd !== undefined &&
                    (path.resolve(session.cwd) === worktreePath ||
                      inside(worktreePath, path.resolve(session.cwd))))),
            )
          )
            return;
          if (previewFolder) previewFolder.category = category;
          return;
        }
        // Re-read after Git/host calls so a queued turn, resumed session or new
        // thread sharing this path cancels the removal.
        const latestSnapshot = yield* readThreads();
        if (yield* containsProjectRoot(worktreePath, [project, ...latestSnapshot.projects])) return;
        const latest = latestSnapshot.threads.filter(
          (entry) =>
            entry.worktreePath !== null && path.resolve(entry.worktreePath) === worktreePath,
        );
        if (hasTerminal(worktreePath)) return;
        if (deleted) {
          if (
            latest.length > 0 ||
            !resolveWorktreeCleanup(yield* settingsService.getSettings, thread.projectId)
              .worktreeOnDelete
          )
            return;
          // A failed session stop is logged by the deletion reactor. Its drain
          // alone is not proof that a provider released this checkout.
          if (
            (yield* providers.listSessions()).some(
              (session) =>
                session.status !== "closed" &&
                (session.threadId === thread.id ||
                  (session.cwd !== undefined &&
                    (path.resolve(session.cwd) === worktreePath ||
                      inside(worktreePath, path.resolve(session.cwd))))),
            )
          )
            return;
        } else if (
          latest.length !== 1 ||
          latest[0]!.id !== thread.id ||
          !storageCleanupThreadIdle(latest[0]!, now) ||
          storageCleanupActivityAt(latest[0]!) !== storageCleanupActivityAt(thread)
        )
          return;
        const finalStatus = yield* git.statusDetailsLocal(worktreePath);
        if (
          !finalStatus.isRepo ||
          finalStatus.branch !== thread.branch ||
          finalStatus.hasWorkingTreeChanges
        )
          return;
        if (
          (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha !==
          head.commitSha
        )
          return;
        const finalIgnored = yield* git.execute({
          operation: "StorageCleanup.ignoredFiles",
          cwd: worktreePath,
          args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
          maxOutputBytes: 64 * 1024,
        });
        if (
          finalIgnored.stdoutTruncated ||
          finalIgnored.stdout
            .split("\0")
            .some((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry))
        )
          return;
        const current = resolveWorktreeCleanup(
          yield* settingsService.getSettings,
          thread.projectId,
        );
        if (
          Object.keys(settings).some(
            (key) =>
              current[key as keyof typeof settings] !== settings[key as keyof typeof settings],
          )
        )
          return;
        yield* git.removeWorktree({ cwd: project.workspaceRoot, path: worktreePath, force: false });
        previewCache.length = 0;
        yield* gitManager.invalidateStatus(project.workspaceRoot);
        // Preserve branch and path: ProviderCommandReactor recreates the checkout
        // from that branch when the thread is resumed.
        yield* Effect.logInfo("storage cleanup removed worktree", { threadId: thread.id });
      }).pipe(
        (effect) =>
          preview
            ? effect.pipe(Effect.timeout("3 seconds"))
            : withWorkspaceLease(worktreePath, effect),
        Effect.catch((error) => {
          if (preview) preview.unavailable++;
          if (previewFolder) previewFolder.category = "unchecked";
          return Effect.logDebug("storage cleanup skipped worktree", {
            threadId: thread.id,
            error,
          });
        }),
      );
      if (preview) preview.checked++;
    }
  });

  const revision = yield* SubscriptionRef.make(0);
  const previewGate = yield* Semaphore.make(1);
  const previewCache: Array<{
    input: StorageCleanupPreviewInput;
    settings: ServerSettings;
    at: number;
    result: StorageCleanupPreview;
  }> = [];
  const preview = Effect.fn("StorageCleanup.preview")(function* (
    input: StorageCleanupPreviewInput,
  ) {
    const settings = yield* settingsService.getSettings;
    const now = yield* Clock.currentTimeMillis;
    let cached = previewCache.find(
      (entry) =>
        entry.input.projectId === input.projectId &&
        entry.input.inactiveAfterDays === input.inactiveAfterDays &&
        now - entry.at < 60_000 &&
        Equal.equals(entry.settings.storageCleanup, settings.storageCleanup) &&
        Equal.equals(entry.settings.worktreeCleanup, settings.worktreeCleanup) &&
        sameProjectWorktreePolicies(entry.settings, settings),
    );
    if (!cached) {
      // Inspect all cleanup categories without enabling any rule. Each folder is assigned
      // once, in deleted / inactive / merged / unchanged order, so totals are additive.
      const previewRules = (rules: WorktreeCleanupRules): WorktreeCleanupRules => ({
        worktreeOnDelete: true,
        worktreeAfterDays:
          input.inactiveAfterDays === undefined
            ? (rules.worktreeAfterDays ?? 8)
            : (input.inactiveAfterDays ?? 8),
        worktreeOnMerge: true,
        worktreeUnchanged: true,
      });
      const overrides = Object.fromEntries(
        Object.keys(settings.projectSettingsOverrides).map((id) => [
          id,
          {
            ...settings.projectSettingsOverrides[id as ProjectId],
            worktreeCleanup: {
              mode: "custom" as const,
              rules: previewRules(resolveWorktreeCleanup(settings, id as ProjectId)),
            },
          },
        ]),
      );
      const scan: PreviewScan = { input, total: 0, checked: 0, unavailable: 0, folders: [] };
      yield* cleanWorktrees(
        {
          ...settings,
          worktreeCleanup: null,
          storageCleanup: {
            ...settings.storageCleanup,
            ...previewRules(resolveWorktreeCleanup(settings, null)),
          },
          projectSettingsOverrides: overrides,
        },
        now,
        scan,
      ).pipe(
        Effect.catch(() => {
          scan.unavailable++;
          return Effect.void;
        }),
      );
      const measurementStartedAt = yield* Clock.currentTimeMillis;
      for (const folder of scan.folders) {
        if ((yield* Clock.currentTimeMillis) - measurementStartedAt >= 10_000) break;
        folder.bytes = yield* measureWorktreeBytes(folder.path).pipe(
          Effect.provideService(Path.Path, path),
        );
      }
      const total = { folders: 0, measured: 0, bytes: 0 };
      const kinds = ["deleted", "inactive", "merged", "unchanged", "kept", "unchecked"] as const;
      const categories = kinds.map((kind) => ({ kind, folders: 0, measured: 0, bytes: 0 }));
      const projectIds = new Set<ProjectId>();
      for (const folder of scan.folders) {
        const category = categories.find((entry) => entry.kind === folder.category)!;
        projectIds.add(folder.projectId);
        for (const summary of [total, category]) {
          summary.folders++;
          if (folder.bytes !== null) {
            summary.measured++;
            summary.bytes += folder.bytes;
          }
        }
      }
      const result: StorageCleanupPreview = {
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        unchecked: Math.max(0, scan.total - scan.checked),
        unavailable: scan.unavailable,
        total,
        categories,
        projectCount: projectIds.size,
      };
      cached = { input, settings, at: now, result };
      if (previewCache.length >= 8) previewCache.shift();
      previewCache.push(cached);
    }
    return cached.result;
  }, previewGate.withPermits(1));

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
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("storage cleanup failed", { cause }),
      ),
      Effect.andThen(
        Effect.sync(() => {
          previewCache.length = 0;
        }),
      ),
      Effect.andThen(SubscriptionRef.update(revision, (value) => value + 1)),
      previewGate.withPermits(1),
    ),
  );

  const start = Effect.fn("StorageCleanup.start")(function* () {
    const unsubscribe = yield* terminals.subscribeMetadata((event) =>
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
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    const changes = yield* settingsService.subscribeChanges;
    const events = yield* engine.subscribeDomainEvents;
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
        event.type === "thread.deleted" &&
        anyWorktreePolicy(lastSettings, (rules) => rules.worktreeOnDelete)
          ? worker.enqueue(undefined)
          : Effect.void,
      ),
    );
  });
  return {
    start,
    drain: worker.drain,
    preview,
    revisions: SubscriptionRef.changes(revision),
  } satisfies StorageCleanup["Service"];
});

export const layer = Layer.effect(StorageCleanup, make);
