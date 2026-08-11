import {
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type WorktreeCleanupNotice,
  type WorktreeCleanupNoticeReason,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import { GitWorkflowService } from "./git/GitWorkflowService.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSetupScriptRunner } from "./project/ProjectSetupScriptRunner.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import { forkParked } from "./serverActivation.ts";
import { TerminalManager } from "./terminal/Manager.ts";
import { GitVcsDriver } from "./vcs/GitVcsDriver.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const WORKTREE_RETIRE_AFTER_DAYS = 7;
const SWEEP_INTERVAL = Duration.hours(24);
const STATE_FILE_NAME = "worktree-cleanup.json";

const CleanupEntry = Schema.Struct({
  worktreePath: Schema.String,
  artifactsPrunedAt: Schema.NullOr(Schema.String),
  worktreeRemovedAt: Schema.NullOr(Schema.String),
});

const CleanupState = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Array(CleanupEntry),
  notices: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      worktreePath: Schema.String,
      projectTitle: Schema.String,
      branch: Schema.NullOr(Schema.String),
      reason: Schema.Literals([
        "local-changes",
        "local-files",
        "no-upstream",
        "unpushed-commits",
        "inspection-failed",
        "removal-failed",
      ]),
      createdAt: Schema.String,
    }),
  ),
});
type CleanupState = typeof CleanupState.Type;

const CleanupStateJson = Schema.fromJsonString(CleanupState);
const decodeCleanupState = Schema.decodeUnknownEffect(CleanupStateJson);
const encodeCleanupState = Schema.encodeEffect(CleanupStateJson);

const EMPTY_STATE: CleanupState = {
  version: 1,
  entries: [],
  notices: [],
};

interface ArtifactRule {
  readonly directory: string;
  readonly markers: ReadonlyArray<string>;
}

/** Marker files make same-named source directories safe across language ecosystems. */
const ARTIFACT_RULES: ReadonlyArray<ArtifactRule> = [
  { directory: "node_modules", markers: ["package.json"] },
  { directory: ".next", markers: ["package.json"] },
  { directory: ".turbo", markers: ["package.json", "turbo.json"] },
  { directory: "target", markers: ["Cargo.toml"] },
  { directory: "vendor", markers: ["composer.json", "Cargo.toml"] },
  { directory: ".venv", markers: ["pyproject.toml", "requirements.txt"] },
  { directory: ".build", markers: ["Package.swift"] },
  { directory: "Pods", markers: ["Podfile"] },
  {
    directory: ".gradle",
    markers: ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts"],
  },
  { directory: "build", markers: ["build.gradle", "build.gradle.kts"] },
];

const ARTIFACT_DIRECTORY_NAMES = new Set(ARTIFACT_RULES.map((rule) => rule.directory));
const WALK_SKIP_NAMES = new Set([".git", ".t3", ...ARTIFACT_DIRECTORY_NAMES]);

export function artifactDirectoryNamesForEntries(entries: Iterable<string>): ReadonlyArray<string> {
  const entryNames = new Set(entries);
  return ARTIFACT_RULES.filter(
    (rule) =>
      entryNames.has(rule.directory) && rule.markers.some((marker) => entryNames.has(marker)),
  ).map((rule) => rule.directory);
}

interface WorktreeGroup {
  readonly path: string;
  readonly project: OrchestrationProjectShell;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly lastUpdatedAt: string;
}

export function groupManagedWorktrees(input: {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
}): ReadonlyArray<WorktreeGroup> {
  const projects = new Map(input.projects.map((project) => [project.id, project] as const));
  const groups = new Map<string, Array<OrchestrationThreadShell>>();
  for (const thread of input.threads) {
    if (!thread.worktreePath) continue;
    const existing = groups.get(thread.worktreePath) ?? [];
    existing.push(thread);
    groups.set(thread.worktreePath, existing);
  }

  return [...groups.entries()].flatMap(([worktreePath, threads]) => {
    const firstThread = threads[0];
    if (!firstThread) return [];
    const project = projects.get(firstThread.projectId);
    if (!project) return [];
    const lastUpdatedAt = threads.reduce(
      (latest, thread) => (thread.updatedAt > latest ? thread.updatedAt : latest),
      threads[0]?.updatedAt ?? project.updatedAt,
    );
    return [{ path: worktreePath, project, threads, lastUpdatedAt }];
  });
}

function cleanupStatesEqual(left: CleanupState, right: CleanupState): boolean {
  return (
    left.entries.length === right.entries.length &&
    left.notices.length === right.notices.length &&
    left.entries.every((entry, index) => {
      const other = right.entries[index];
      return (
        other !== undefined &&
        entry.worktreePath === other.worktreePath &&
        entry.artifactsPrunedAt === other.artifactsPrunedAt &&
        entry.worktreeRemovedAt === other.worktreeRemovedAt
      );
    }) &&
    left.notices.every((notice, index) => {
      const other = right.notices[index];
      return (
        other !== undefined &&
        notice.id === other.id &&
        notice.worktreePath === other.worktreePath &&
        notice.projectTitle === other.projectTitle &&
        notice.branch === other.branch &&
        notice.reason === other.reason &&
        notice.createdAt === other.createdAt
      );
    })
  );
}

function isPathWithinRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

function noticeId(worktreePath: string, reason: WorktreeCleanupNoticeReason): string {
  return `${reason}:${worktreePath}`;
}

function worktreeIsBusy(group: WorktreeGroup, runningTerminalThreadIds: ReadonlySet<string>) {
  return group.threads.some(
    (thread) =>
      runningTerminalThreadIds.has(thread.id) ||
      thread.backgroundLiveness != null ||
      (thread.session !== null && thread.session.status !== "stopped"),
  );
}

export class WorktreePreparationError extends Schema.TaggedErrorClass<WorktreePreparationError>()(
  "WorktreePreparationError",
  {
    worktreePath: Schema.String,
    operation: Schema.Literals(["recreate", "inspect"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} managed worktree '${this.worktreePath}'.`;
  }
}

export class WorktreeCleanup extends Context.Service<
  WorktreeCleanup,
  {
    readonly start: () => Effect.Effect<void, never, import("effect/Scope").Scope>;
    readonly runNow: Effect.Effect<void>;
    readonly notices: Effect.Effect<ReadonlyArray<WorktreeCleanupNotice>>;
    readonly noticeChanges: Stream.Stream<ReadonlyArray<WorktreeCleanupNotice>>;
    readonly prepareForTurn: (input: {
      readonly threadId: string;
      readonly projectId: string;
      readonly projectCwd: string;
      readonly branch: string | null;
      readonly worktreePath: string | null;
    }) => Effect.Effect<void, WorktreePreparationError>;
  }
>()("t3/worktreeCleanup") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettingsService;
  const projections = yield* ProjectionSnapshotQuery;
  const terminals = yield* TerminalManager;
  const git = yield* GitVcsDriver;
  const gitWorkflow = yield* GitWorkflowService;
  const setupScripts = yield* ProjectSetupScriptRunner;
  const lock = yield* Semaphore.make(1);
  const noticePubSub = yield* PubSub.sliding<ReadonlyArray<WorktreeCleanupNotice>>(1);
  const statePath = path.join(config.stateDir, STATE_FILE_NAME);

  const initialState = yield* fileSystem.exists(statePath).pipe(
    Effect.flatMap((exists) =>
      exists
        ? fileSystem.readFileString(statePath).pipe(
            Effect.flatMap(decodeCleanupState),
            Effect.catchCause((cause) =>
              Effect.logWarning("worktree cleanup state could not be read", { cause }).pipe(
                Effect.as(EMPTY_STATE),
              ),
            ),
          )
        : Effect.succeed(EMPTY_STATE),
    ),
  );
  const stateRef = yield* Ref.make<CleanupState>(initialState);

  const persistState = Effect.fn("WorktreeCleanup.persistState")(function* (state: CleanupState) {
    const encoded = yield* encodeCleanupState(state);
    const temporaryPath = `${statePath}.tmp`;
    yield* fileSystem.writeFileString(temporaryPath, encoded);
    yield* fileSystem.rename(temporaryPath, statePath);
  });

  const publishState = Effect.fn("WorktreeCleanup.publishState")(function* (state: CleanupState) {
    yield* Ref.set(stateRef, state);
    yield* persistState(state);
    yield* PubSub.publish(noticePubSub, state.notices);
  });

  const managedExistingPath = Effect.fn("WorktreeCleanup.managedExistingPath")(function* (
    candidate: string,
  ) {
    const normalizedRoot = path.resolve(config.worktreesDir);
    const normalizedCandidate = path.resolve(candidate);
    if (!isPathWithinRoot(path, normalizedRoot, normalizedCandidate)) return null;
    if (!(yield* fileSystem.exists(normalizedCandidate))) return null;
    const [realRoot, realCandidate] = yield* Effect.all([
      fileSystem.realPath(normalizedRoot),
      fileSystem.realPath(normalizedCandidate),
    ]);
    return isPathWithinRoot(path, realRoot, realCandidate) ? normalizedCandidate : null;
  });

  const findArtifactDirectories = Effect.fn("WorktreeCleanup.findArtifactDirectories")(function* (
    worktreePath: string,
  ) {
    const root = yield* managedExistingPath(worktreePath);
    if (!root) return [];
    const realRoot = yield* fileSystem.realPath(root);
    const queue = [root];
    const visitedDirectories = new Set<string>();
    const artifacts: string[] = [];

    while (queue.length > 0) {
      const directory = queue.pop();
      if (!directory) continue;
      const realDirectory = yield* fileSystem
        .realPath(directory)
        .pipe(Effect.orElseSucceed(() => null));
      if (!realDirectory || visitedDirectories.has(realDirectory)) continue;
      visitedDirectories.add(realDirectory);
      const entries = yield* fileSystem
        .readDirectory(directory, { recursive: false })
        .pipe(Effect.orElseSucceed(() => []));
      const entryNames = new Set(entries);

      for (const artifactDirectory of artifactDirectoryNamesForEntries(entryNames)) {
        const candidate = path.join(directory, artifactDirectory);
        const ignored = yield* git
          .execute({
            operation: "WorktreeCleanup.checkIgnoredArtifact",
            cwd: root,
            args: ["check-ignore", "-q", "--", path.relative(root, candidate)],
            allowNonZeroExit: true,
          })
          .pipe(
            Effect.map((result) => result.exitCode === 0),
            Effect.orElseSucceed(() => false),
          );
        if (!ignored) continue;
        const realCandidate = yield* fileSystem
          .realPath(candidate)
          .pipe(Effect.orElseSucceed(() => null));
        if (!realCandidate || !isPathWithinRoot(path, realRoot, realCandidate)) continue;
        artifacts.push(candidate);
      }

      for (const entry of entries) {
        if (WALK_SKIP_NAMES.has(entry)) continue;
        const child = path.join(directory, entry);
        const info = yield* fileSystem.stat(child).pipe(Effect.orElseSucceed(() => null));
        if (info?.type !== "Directory") continue;
        const realChild = yield* fileSystem.realPath(child).pipe(Effect.orElseSucceed(() => null));
        if (!realChild || !isPathWithinRoot(path, realRoot, realChild)) {
          continue;
        }
        queue.push(child);
      }
    }

    return [...new Set(artifacts)].toSorted();
  });

  const pruneArtifacts = Effect.fn("WorktreeCleanup.pruneArtifacts")(function* (
    worktreePath: string,
  ) {
    const artifacts = yield* findArtifactDirectories(worktreePath);
    for (const artifact of artifacts) {
      yield* fileSystem.remove(artifact, { recursive: true, force: true }).pipe(
        Effect.tap(() =>
          Effect.logInfo("worktree cleanup removed generated artifact", { artifact }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("worktree cleanup could not remove generated artifact", {
            artifact,
            cause,
          }),
        ),
      );
    }
    return artifacts.length;
  });

  const localRetirementBlocker = Effect.fn("WorktreeCleanup.localRetirementBlocker")(function* (
    worktreePath: string,
  ) {
    const result = yield* git.execute({
      operation: "WorktreeCleanup.retirementStatus",
      cwd: worktreePath,
      args: ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "-z"],
    });
    const records = result.stdout.split("\0").filter(Boolean);
    if (records.some((record) => record.startsWith("!! "))) return "local-files" as const;
    if (records.length > 0) return "local-changes" as const;
    return null;
  });

  const verifiedRemoteStatus = Effect.fn("WorktreeCleanup.verifiedRemoteStatus")(function* (
    worktreePath: string,
  ) {
    const status = yield* git.statusDetailsRemote(worktreePath, { refreshUpstream: false });
    if (!status.hasUpstream || !status.branch) return status;

    const [remoteResult, mergeResult] = yield* Effect.all([
      git.execute({
        operation: "WorktreeCleanup.upstreamRemote",
        cwd: worktreePath,
        args: ["config", "--get", `branch.${status.branch}.remote`],
        allowNonZeroExit: true,
      }),
      git.execute({
        operation: "WorktreeCleanup.upstreamMergeRef",
        cwd: worktreePath,
        args: ["config", "--get", `branch.${status.branch}.merge`],
        allowNonZeroExit: true,
      }),
    ]);
    const remoteName = remoteResult.stdout.trim();
    const mergeRef = mergeResult.stdout.trim();
    const headsPrefix = "refs/heads/";
    if (
      remoteResult.exitCode !== 0 ||
      mergeResult.exitCode !== 0 ||
      remoteName.length === 0 ||
      remoteName === "." ||
      !mergeRef.startsWith(headsPrefix)
    ) {
      return { ...status, hasUpstream: false, upstreamRef: null };
    }

    yield* git.fetchRemoteTrackingBranch({
      cwd: worktreePath,
      remoteName,
      remoteBranch: mergeRef.slice(headsPrefix.length),
    });
    const refreshedStatus = yield* git.statusDetailsRemote(worktreePath, {
      refreshUpstream: false,
    });
    if (!refreshedStatus.upstreamRef) {
      return { ...refreshedStatus, hasUpstream: false };
    }
    const containsHead = yield* git.execute({
      operation: "WorktreeCleanup.verifyPushedHead",
      cwd: worktreePath,
      args: ["merge-base", "--is-ancestor", "HEAD", refreshedStatus.upstreamRef],
      allowNonZeroExit: true,
    });
    return containsHead.exitCode === 0
      ? refreshedStatus
      : { ...refreshedStatus, aheadCount: Math.max(1, refreshedStatus.aheadCount) };
  });

  const makeNotice = (
    group: WorktreeGroup,
    reason: WorktreeCleanupNoticeReason,
    createdAt: string,
    previous: ReadonlyMap<string, WorktreeCleanupNotice>,
  ): WorktreeCleanupNotice => {
    const id = noticeId(group.path, reason);
    return (
      previous.get(id) ?? {
        id,
        worktreePath: group.path,
        projectTitle: group.project.title,
        branch: group.threads.find((thread) => thread.branch !== null)?.branch ?? null,
        reason,
        createdAt,
      }
    );
  };

  const runSweep = lock.withPermits(1)(
    Effect.gen(function* () {
      const cleanupAfterDays = (yield* settings.getSettings).worktreeCleanupAfterDays;
      if (cleanupAfterDays === null) {
        const currentState = yield* Ref.get(stateRef);
        if (currentState.notices.length > 0) {
          yield* publishState({ ...currentState, notices: [] });
        }
        return;
      }

      const [active, archived, terminalMetadata, currentState, now] = yield* Effect.all([
        projections.getShellSnapshot(),
        projections.getArchivedShellSnapshot(),
        terminals.listMetadata(),
        Ref.get(stateRef),
        DateTime.now,
      ]);
      const nowMs = DateTime.toEpochMillis(now);
      const nowIso = DateTime.formatIso(now);
      const groups = groupManagedWorktrees({
        projects: [...active.projects, ...archived.projects],
        threads: [...active.threads, ...archived.threads],
      });
      const runningTerminalThreadIds = new Set(
        terminalMetadata
          .filter((terminal) => terminal.status === "running" || terminal.hasRunningSubprocess)
          .map((terminal) => terminal.threadId),
      );
      const entries = new Map(currentState.entries.map((entry) => [entry.worktreePath, entry]));
      const previousNotices = new Map(currentState.notices.map((notice) => [notice.id, notice]));
      const notices: WorktreeCleanupNotice[] = [];

      for (const group of groups) {
        const lastUpdatedMs = DateTime.toEpochMillis(DateTime.makeUnsafe(group.lastUpdatedAt));
        const inactiveMs = Math.max(0, nowMs - lastUpdatedMs);
        if (
          inactiveMs < cleanupAfterDays * DAY_MS ||
          worktreeIsBusy(group, runningTerminalThreadIds)
        ) {
          continue;
        }

        const managedPath = yield* managedExistingPath(group.path).pipe(
          Effect.catchCause(() => Effect.succeed(null)),
        );
        if (!managedPath) continue;

        const removedArtifactCount = yield* pruneArtifacts(managedPath);
        if (removedArtifactCount > 0) {
          const previousEntry = entries.get(group.path);
          entries.set(group.path, {
            worktreePath: group.path,
            artifactsPrunedAt: previousEntry?.artifactsPrunedAt ?? nowIso,
            worktreeRemovedAt: previousEntry?.worktreeRemovedAt ?? null,
          });
        }

        if (inactiveMs < WORKTREE_RETIRE_AFTER_DAYS * DAY_MS) continue;

        const localBlocker = yield* localRetirementBlocker(managedPath).pipe(
          Effect.catchCause((cause) => {
            notices.push(makeNotice(group, "inspection-failed", nowIso, previousNotices));
            return Effect.logWarning("worktree cleanup could not inspect local state", {
              worktreePath: group.path,
              cause,
            }).pipe(Effect.as("inspection-failed" as const));
          }),
        );
        if (localBlocker !== null) {
          if (localBlocker !== "inspection-failed") {
            notices.push(makeNotice(group, localBlocker, nowIso, previousNotices));
          }
          continue;
        }

        const remote = yield* verifiedRemoteStatus(managedPath).pipe(
          Effect.catchCause((cause) => {
            notices.push(makeNotice(group, "inspection-failed", nowIso, previousNotices));
            return Effect.logWarning("worktree cleanup could not inspect upstream state", {
              worktreePath: group.path,
              cause,
            }).pipe(Effect.as(null));
          }),
        );
        if (!remote) continue;
        if (!remote.hasUpstream) {
          notices.push(makeNotice(group, "no-upstream", nowIso, previousNotices));
          continue;
        }
        if (remote.aheadCount > 0) {
          notices.push(makeNotice(group, "unpushed-commits", nowIso, previousNotices));
          continue;
        }

        const removed = yield* gitWorkflow
          .removeWorktree({ cwd: group.project.workspaceRoot, path: managedPath })
          .pipe(
            Effect.as(true),
            Effect.catchCause((cause) => {
              notices.push(makeNotice(group, "removal-failed", nowIso, previousNotices));
              return Effect.logWarning("worktree cleanup could not remove safe worktree", {
                worktreePath: group.path,
                cause,
              }).pipe(Effect.as(false));
            }),
          );
        if (!removed) continue;
        entries.set(group.path, {
          worktreePath: group.path,
          artifactsPrunedAt: entries.get(group.path)?.artifactsPrunedAt ?? nowIso,
          worktreeRemovedAt: nowIso,
        });
        yield* Effect.logInfo("worktree cleanup retired inactive worktree", {
          worktreePath: group.path,
          lastUpdatedAt: group.lastUpdatedAt,
        });
      }

      const knownPaths = new Set(groups.map((group) => group.path));
      const nextState: CleanupState = {
        version: 1,
        entries: [...entries.values()].filter((entry) => knownPaths.has(entry.worktreePath)),
        notices,
      };
      if (!cleanupStatesEqual(nextState, currentState)) {
        yield* publishState(nextState);
      }
    }),
  );

  const runSweepSafely = runSweep.pipe(
    Effect.catchCause((cause) => Effect.logWarning("worktree cleanup sweep failed", { cause })),
  );

  const prepareForTurn: WorktreeCleanup["Service"]["prepareForTurn"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (!input.worktreePath) return;
        const worktreePath = input.worktreePath;
        const normalizedRoot = path.resolve(config.worktreesDir);
        const normalizedWorktreePath = path.resolve(worktreePath);
        if (!isPathWithinRoot(path, normalizedRoot, normalizedWorktreePath)) return;

        const currentState = yield* Ref.get(stateRef);
        const entry = currentState.entries.find(
          (candidate) => candidate.worktreePath === worktreePath,
        );
        const exists = yield* fileSystem.exists(normalizedWorktreePath).pipe(
          Effect.mapError(
            (cause) =>
              new WorktreePreparationError({
                worktreePath,
                operation: "inspect",
                cause,
              }),
          ),
        );
        let recreated = false;
        if (!exists) {
          if (!input.branch) {
            return yield* new WorktreePreparationError({
              worktreePath,
              operation: "recreate",
              cause: new Error("The thread has no branch to recreate."),
            });
          }
          yield* gitWorkflow
            .createWorktree({
              cwd: input.projectCwd,
              refName: input.branch,
              path: normalizedWorktreePath,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new WorktreePreparationError({
                    worktreePath,
                    operation: "recreate",
                    cause,
                  }),
              ),
            );
          recreated = true;
        }

        if (recreated || entry?.artifactsPrunedAt) {
          yield* setupScripts
            .runForThread({
              threadId: input.threadId,
              projectId: input.projectId,
              projectCwd: input.projectCwd,
              worktreePath: normalizedWorktreePath,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("worktree cleanup could not restart the setup script", {
                  worktreePath,
                  threadId: input.threadId,
                  cause,
                }),
              ),
            );
        }

        if (
          !entry &&
          !currentState.notices.some((notice) => notice.worktreePath === worktreePath)
        ) {
          return;
        }
        const nextState: CleanupState = {
          version: 1,
          entries: currentState.entries.filter(
            (candidate) => candidate.worktreePath !== worktreePath,
          ),
          notices: currentState.notices.filter((notice) => notice.worktreePath !== worktreePath),
        };
        yield* publishState(nextState).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("worktree cleanup could not clear restored worktree state", {
              worktreePath,
              cause,
            }),
          ),
        );
      }),
    );

  const start: WorktreeCleanup["Service"]["start"] = () =>
    forkParked(runSweepSafely.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))));

  return WorktreeCleanup.of({
    start,
    runNow: runSweepSafely,
    notices: Ref.get(stateRef).pipe(Effect.map((state) => state.notices)),
    noticeChanges: Stream.fromPubSub(noticePubSub),
    prepareForTurn,
  });
});

export const layer = Layer.effect(WorktreeCleanup, make);
