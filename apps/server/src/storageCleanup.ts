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
import { WorktreeSize } from "./storageCleanupSize.ts";
import * as TxRef from "effect/TxRef";
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
  inactiveActivityAt?: number;
}

interface PreviewScan {
  readonly input: StorageCleanupPreviewInput;
  total: number | undefined;
  examined: number;
  skippedMeasurements: number;
  checked: number;
  unavailable: number;
  readonly folders: PreviewFolder[];
  discovered: boolean;
  readonly onFolder: (folder: PreviewFolder, activity: number) => Effect.Effect<void>;
  readonly progress: Effect.Effect<void>;
  readonly onDiscovery: Effect.Effect<void>;
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
  const worktreeSize = yield* WorktreeSize;
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
  const observers = yield* TxRef.make({ count: 0, requestedAt: 0 });
  const awaitInterest = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* TxRef.get(observers).pipe(
      Effect.tap((state) =>
        state.count > 0 || now - state.requestedAt < 30_000 ? Effect.void : Effect.txRetry,
      ),
      Effect.tx,
    );
  });
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
    const previewFolders = new Map<string, PreviewFolder>();
    if (preview) {
      preview.total = scopedCandidates.length;
      yield* preview.onDiscovery;
      // Discover and queue sizes before Git classification can block on a repository.
      for (const thread of scopedCandidates) {
        yield* awaitInterest;
        const folder = path.resolve(thread.worktreePath!);
        const foldersBefore = preview.folders.length;
        yield* Effect.gen(function* () {
          if (!inside(root, folder) || !(yield* fs.exists(folder))) return;
          if ((yield* fs.realPath(folder)) !== folder) return;
          if ((yield* fs.stat(path.join(folder, ".git"))).type !== "File") return;
          const entry: PreviewFolder = {
            projectId: thread.projectId,
            path: folder,
            category: "unchecked",
          };
          previewFolders.set(folder, entry);
          preview.folders.push(entry);
          yield* preview.onFolder(
            entry,
            "deletedAt" in thread ? 0 : storageCleanupActivityAt(thread),
          );
        }).pipe(
          Effect.catch(() =>
            Effect.sync(() => {
              preview.unavailable++;
            }),
          ),
        );
        preview.examined++;
        if (preview.folders.length === foldersBefore) preview.skippedMeasurements++;
        yield* preview.progress;
      }
    }
    if (preview) preview.discovered = true;
    const classify = Effect.gen(function* () {
      for (const thread of scopedCandidates) {
        if (preview) yield* awaitInterest;
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
          !preview &&
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
        const previewFolder = previewFolders.get(worktreePath);
        yield* Effect.gen(function* () {
          if (preview) {
            if (!previewFolder) return;
            previewFolder.category = "kept";
          } else {
            if (!inside(root, worktreePath) || !(yield* fs.exists(worktreePath))) return;
            if ((yield* fs.realPath(worktreePath)) !== worktreePath) return;
            // A linked worktree has a .git file. Never remove a main checkout.
            if ((yield* fs.stat(path.join(worktreePath, ".git"))).type !== "File") return;
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
          // Cache safety and Git classification independently of the draft retention
          // period, so changing days only recalculates the summary.
          if (previewFolder && !deleted) {
            previewFolder.inactiveActivityAt = storageCleanupActivityAt(thread);
          }
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
                  (pr) =>
                    pr.snapshot?.state === "merged" && pr.snapshot.headBranch === thread.branch,
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
          if (yield* containsProjectRoot(worktreePath, [project, ...latestSnapshot.projects]))
            return;
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
          yield* git.removeWorktree({
            cwd: project.workspaceRoot,
            path: worktreePath,
            force: false,
          });
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
            if (previewFolder) {
              previewFolder.category = "unchecked";
            }
            return Effect.logDebug("storage cleanup skipped worktree", {
              threadId: thread.id,
              error,
            });
          }),
        );
        if (preview) {
          preview.checked++;
          yield* preview.progress;
        }
      }
    });
    if (preview) return classify;
    yield* classify;
  });

  const revision = yield* SubscriptionRef.make(0);
  const previewGate = yield* Semaphore.make(1);
  const CACHE_MS = 5 * 60_000;
  let lastPublished = 0;
  const markCompleted = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const entry of previewCache) {
      if (
        !entry.running &&
        entry.completedAt === undefined &&
        entry.scan.folders.every((folder) => measurements.get(folder.path)?.done)
      ) {
        entry.completedAt = now;
      }
    }
  });
  const publish = Effect.gen(function* () {
    yield* markCompleted;
    const now = yield* Clock.currentTimeMillis;
    if (now - lastPublished < 1000) return;
    lastPublished = now;
    yield* SubscriptionRef.update(revision, (value) => value + 1);
  });
  const publishImmediately = Effect.gen(function* () {
    yield* markCompleted;
    lastPublished = yield* Clock.currentTimeMillis;
    yield* SubscriptionRef.update(revision, (value) => value + 1);
  });
  const measurements = new Map<
    string,
    {
      bytes: number;
      done: boolean;
      failed: boolean;
      at: number;
      activity: number;
      refreshKey: string | undefined;
    }
  >();
  const measurementWorker = yield* makeDrainableWorker((folder: string) =>
    Effect.gen(function* () {
      const measurement = measurements.get(folder)!;
      yield* awaitInterest;
      yield* worktreeSize.measure(folder).pipe(
        Stream.runForEach((progress) =>
          Effect.gen(function* () {
            measurement.bytes = progress.bytes;
            measurement.done = progress.done;
            yield* publish;
            yield* Effect.yieldNow;
            if (!progress.done) yield* awaitInterest;
          }),
        ),
        Effect.catch(() =>
          Effect.sync(() => {
            measurement.failed = true;
            measurement.done = true;
          }),
        ),
      );
      measurement.at = yield* Clock.currentTimeMillis;
      yield* measurementsPending() ? publish : publishImmediately;
    }),
  );
  const measurementsPending = () =>
    [...measurements.values()].some((measurement) => !measurement.done);
  const measure = Effect.fn("StorageCleanup.measure")(function* (
    folder: PreviewFolder,
    activity: number,
    refreshKey: string | undefined,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const cached = measurements.get(folder.path);
    if (
      cached &&
      (!cached.done ||
        (now - cached.at < CACHE_MS &&
          cached.activity === activity &&
          (refreshKey === undefined || cached.refreshKey === refreshKey)))
    )
      return;
    // Keep the cache bounded without evicting work that is still running.
    for (const [key, value] of measurements) {
      if (
        value.done &&
        now - value.at >= CACHE_MS &&
        !previewCache.some((entry) => entry.scan.folders.some((folder) => folder.path === key))
      ) {
        measurements.delete(key);
      }
    }
    measurements.set(folder.path, {
      bytes: 0,
      done: false,
      failed: false,
      at: now,
      activity,
      refreshKey,
    });
    yield* measurementWorker.enqueue(folder.path);
  });
  type PreviewEntry = {
    input: StorageCleanupPreviewInput;
    settings: ServerSettings;
    at: number;
    running: boolean;
    completedAt?: number;
    previous?: StorageCleanupPreview | undefined;
    result?: StorageCleanupPreview;
    scan: PreviewScan;
  };
  const previewCache: PreviewEntry[] = [];
  const classificationWorker = yield* makeDrainableWorker(
    ({ entry, classify }: { entry: PreviewEntry; classify: Effect.Effect<void> }) =>
      Effect.gen(function* () {
        yield* classify;
        entry.running = false;
        yield* publishImmediately;
      }),
  );
  // Discover each requested scope before serial Git checks, so a project preview
  // can show progress even while another scope is being classified.
  const discoveryWorker = yield* makeDrainableWorker((entry: PreviewEntry) =>
    Effect.gen(function* () {
      const settings = entry.settings;
      const previewRules = (rules: WorktreeCleanupRules): WorktreeCleanupRules => ({
        worktreeOnDelete: true,
        worktreeAfterDays: rules.worktreeAfterDays ?? 8,
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
      const classify = yield* cleanWorktrees(
        {
          ...settings,
          worktreeCleanup: null,
          storageCleanup: {
            ...settings.storageCleanup,
            ...previewRules(resolveWorktreeCleanup(settings, null)),
          },
          projectSettingsOverrides: overrides,
        },
        entry.at,
        entry.scan,
      ).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            entry.scan.unavailable++;
          }),
        ),
      );
      if (classify) {
        yield* classificationWorker.enqueue({ entry, classify });
      } else {
        entry.running = false;
      }
      yield* publishImmediately;
    }),
  );
  const preview = Effect.fn("StorageCleanup.preview")(function* (
    input: StorageCleanupPreviewInput,
  ): Effect.fn.Return<StorageCleanupPreview, ServerSettingsError> {
    const settings = yield* settingsService.getSettings;
    const now = yield* Clock.currentTimeMillis;
    yield* TxRef.update(observers, (state) => ({ ...state, requestedAt: now }));
    let entry = previewCache.find(
      (entry) =>
        entry.input.projectId === input.projectId &&
        entry.input.refreshKey === input.refreshKey &&
        (entry.completedAt === undefined || now - entry.completedAt < CACHE_MS) &&
        Equal.equals(entry.settings.storageCleanup, settings.storageCleanup) &&
        Equal.equals(entry.settings.worktreeCleanup, settings.worktreeCleanup) &&
        sameProjectWorktreePolicies(entry.settings, settings),
    );
    if (!entry) {
      entry = {
        input,
        settings,
        at: now,
        running: true,
        previous: previewCache.findLast(
          (entry) => entry.input.projectId === input.projectId && entry.result !== undefined,
        )?.result,
        scan: {
          input,
          total: undefined,
          examined: 0,
          skippedMeasurements: 0,
          checked: 0,
          unavailable: 0,
          folders: [],
          discovered: false,
          onFolder: (folder, activity) => measure(folder, activity, input.refreshKey),
          progress: publish,
          onDiscovery: publishImmediately,
        },
      };
      if (previewCache.length >= 8) {
        const oldest = previewCache.findIndex((entry) => !entry.running);
        if (oldest >= 0) previewCache.splice(oldest, 1);
      }
      previewCache.push(entry);
      yield* discoveryWorker.enqueue(entry);
    }
    // Each candidate has discovery, measurement and eligibility work. A rejected
    // candidate completes its measurement slot without scheduling a filesystem walk.
    const progress =
      entry.scan.total === undefined
        ? {}
        : {
            progress: {
              total: entry.scan.total * 3,
              completed:
                entry.scan.examined +
                entry.scan.skippedMeasurements +
                entry.scan.checked +
                entry.scan.folders.filter((folder) => measurements.get(folder.path)?.done).length,
            },
          };
    if (entry.running && !entry.scan.discovered && entry.previous) {
      const { progress: _progress, ...previous } = entry.previous;
      return { ...previous, scanning: true, ...progress };
    }
    const total = { folders: 0, measured: 0, bytes: 0 };
    const kinds = ["deleted", "inactive", "merged", "unchanged", "kept", "unchecked"] as const;
    const categories = kinds.map((kind) => ({ kind, folders: 0, measured: 0, bytes: 0 }));
    const projectIds = new Set<ProjectId>();
    let scanning = entry.running;
    for (const folder of entry.scan.folders) {
      const inactiveAfterDays =
        input.inactiveAfterDays ??
        resolveWorktreeCleanup(settings, folder.projectId).worktreeAfterDays ??
        8;
      const kind =
        folder.inactiveActivityAt !== undefined &&
        folder.inactiveActivityAt < entry.at - inactiveAfterDays * DAY_MS
          ? "inactive"
          : folder.category;
      const category = categories.find((entry) => entry.kind === kind)!;
      const measurement = measurements.get(folder.path);
      scanning ||= !!measurement && !measurement.done;
      projectIds.add(folder.projectId);
      for (const summary of [total, category]) {
        summary.folders++;
        summary.bytes += measurement?.bytes ?? 0;
        if (measurement?.done && !measurement.failed) summary.measured++;
      }
    }
    const result = {
      checkedAt: DateTime.formatIso(DateTime.makeUnsafe(entry.at)),
      scanning,
      ...progress,
      unchecked: Math.max(0, (entry.scan.total ?? 0) - entry.scan.checked),
      unavailable: entry.scan.unavailable,
      total,
      categories,
      projectCount: projectIds.size,
    } satisfies StorageCleanupPreview;
    entry.result = result;
    return result;
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
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("storage cleanup failed", { cause }),
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
        Effect.gen(function* () {
          if (
            event.type === "thread.deleted" &&
            anyWorktreePolicy(lastSettings, (rules) => rules.worktreeOnDelete)
          ) {
            yield* worker.enqueue(undefined);
          }
          if (
            previewCache.length === 0 ||
            (event.type !== "thread.turn-diff-completed" && event.type !== "thread.reverted")
          )
            return;
          const thread = yield* snapshots.getThreadShellById(event.payload.threadId);
          const folder = Option.getOrNull(thread)?.worktreePath;
          if (!folder) return;
          const measurement = measurements.get(path.resolve(folder));
          if (measurement?.done) measurement.at = 0;
          for (const entry of previewCache) {
            if (
              !entry.running &&
              entry.scan.folders.some((entry) => entry.path === path.resolve(folder))
            ) {
              entry.completedAt = 0;
            }
          }
          yield* publishImmediately;
        }).pipe(
          Effect.catch((error) =>
            Effect.logDebug("storage preview invalidation failed", { error }),
          ),
        ),
      ),
    );
  });
  return {
    start,
    drain: Effect.gen(function* () {
      yield* worker.drain;
      yield* discoveryWorker.drain;
      yield* classificationWorker.drain;
      yield* measurementWorker.drain;
    }),
    preview,
    revisions: Stream.unwrap(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          TxRef.update(observers, (state) => ({ ...state, count: state.count + 1 })),
          () => TxRef.update(observers, (state) => ({ ...state, count: state.count - 1 })),
        );
        return SubscriptionRef.changes(revision);
      }),
    ),
  } satisfies StorageCleanup["Service"];
});

export const layer = Layer.effect(StorageCleanup, make);
