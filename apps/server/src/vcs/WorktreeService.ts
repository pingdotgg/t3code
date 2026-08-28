import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  type GitCommandError,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type VcsListWorktreesInput,
  type VcsListWorktreesResult,
  type VcsPruneWorktreesInput,
  type VcsPruneWorktreesResult,
  type WorktreeInfo,
  type WorktreeInventoryErrorStage,
  type WorktreePruneBlocker,
  type WorktreePruneSkipReason,
  type WorktreeProjectRef,
  type WorktreeThreadRef,
  type WorktreeThreadStatus,
  WorktreeInventoryError,
  WorktreeMutationError,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as WorktreeLifecycle from "./WorktreeLifecycle.ts";

const WORKTREE_STATUS_CONCURRENCY = 8;
const PROJECT_SCAN_CONCURRENCY = 4;

interface ProjectGroup {
  readonly canonicalWorkspaceRoot: string;
  readonly projects: ReadonlyArray<ProjectReference>;
}

interface ProjectReference {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

interface BranchSyncInfo {
  readonly upstream: string | null;
  readonly upstreamGone: boolean;
  readonly aheadOfUpstreamCount: number | null;
  readonly behindUpstreamCount: number | null;
}

function parseBranchSyncInfo(stdout: string): Map<string, BranchSyncInfo> {
  const result = new Map<string, BranchSyncInfo>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const [name, upstream = "", track = ""] = line.split("\t");
    if (!name) continue;
    if (upstream.length === 0) {
      result.set(name, {
        upstream: null,
        upstreamGone: false,
        aheadOfUpstreamCount: null,
        behindUpstreamCount: null,
      });
      continue;
    }
    if (track.trim() === "gone") {
      result.set(name, {
        upstream,
        upstreamGone: true,
        aheadOfUpstreamCount: null,
        behindUpstreamCount: null,
      });
      continue;
    }
    const aheadMatch = /(?:^|, )ahead (\d+)/.exec(track);
    const behindMatch = /(?:^|, )behind (\d+)/.exec(track);
    result.set(name, {
      upstream,
      upstreamGone: false,
      aheadOfUpstreamCount: aheadMatch ? Number(aheadMatch[1]) : 0,
      behindUpstreamCount: behindMatch ? Number(behindMatch[1]) : 0,
    });
  }
  return result;
}

function threadStatus(thread: OrchestrationV2ThreadShell): WorktreeThreadStatus {
  if (thread.deletedAt !== null) return "deleted";
  if (thread.archivedAt !== null) return "archived";
  if (thread.settledOverride === "settled") return "settled";
  return "active";
}

function latestIsoTimestamp(values: ReadonlyArray<string>): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms) && ms > latestMs) {
      latestMs = ms;
      latest = value;
    }
  }
  return latest;
}

function isPathInside(
  root: string,
  candidate: string,
  path: {
    readonly relative: (from: string, to: string) => string;
    readonly isAbsolute: (value: string) => boolean;
    readonly sep: string;
  },
): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function inventoryError(
  stage: WorktreeInventoryErrorStage,
  cause: unknown,
  context: { readonly projectId?: ProjectId; readonly workspaceRoot?: string } = {},
): WorktreeInventoryError {
  return new WorktreeInventoryError({
    stage,
    ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
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
    readonly pruneWorktrees: (
      input: VcsPruneWorktreesInput,
    ) => Effect.Effect<VcsPruneWorktreesResult, WorktreeMutationError>;
    readonly pruneOrphanedWorktree: (
      worktreePath: string,
    ) => Effect.Effect<boolean, WorktreeMutationError>;
  }
>()("t3/vcs/WorktreeService") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projectsService = yield* ProjectService.ProjectService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const lifecycle = yield* WorktreeLifecycle.WorktreeLifecycle;

  // Canonicalize through symlinks so configured roots, Git metadata, and V2
  // thread paths compare equal on hosts such as macOS (/var vs /private/var).
  const canonicalizePath = (value: string) =>
    fs.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));
  const managedWorktreesRoot = yield* canonicalizePath(config.worktreesDir);

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

  const resolveDefaultRef = Effect.fn("WorktreeService.resolveDefaultRef")(function* (cwd: string) {
    const originHead = yield* executeLenient("WorktreeService.resolveDefaultRef", cwd, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
    ]);
    if (originHead !== null && originHead.trim().length > 0) {
      return originHead.trim();
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

  /** Commits on `revision` that the default ref does not have. A branch passes
      its ref from the repository root; a detached worktree passes HEAD from its
      own path. */
  const countAheadOfDefault = Effect.fn("WorktreeService.countAheadOfDefault")(function* (
    cwd: string,
    revision: string,
    defaultRef: string,
  ) {
    const stdout = yield* executeLenient("WorktreeService.countAheadOfDefault", cwd, [
      "rev-list",
      "--count",
      revision,
      "--not",
      defaultRef,
    ]);
    if (stdout === null) return null;
    const count = Number(stdout.trim());
    return Number.isInteger(count) && count >= 0 ? count : null;
  });

  const freshPruneBlocker = Effect.fn("WorktreeService.freshPruneBlocker")(function* (
    worktree: WorktreeInfo,
  ): Effect.fn.Return<WorktreePruneSkipReason | null, GitCommandError> {
    const status = yield* git.statusDetailsLocal(worktree.path);
    if (!status.isRepo || status.branch !== worktree.branch) {
      return "status_unavailable";
    }
    if (status.hasWorkingTreeChanges) {
      return "dirty";
    }
    if (status.branch === null) {
      // Detached HEAD: safe once its commit is already on the default ref.
      const defaultRef = yield* resolveDefaultRef(worktree.workspaceRoot);
      if (defaultRef === null) return "status_unavailable";
      const aheadOfDefaultCount = yield* countAheadOfDefault(worktree.path, "HEAD", defaultRef);
      if (aheadOfDefaultCount === null) return "status_unavailable";
      return aheadOfDefaultCount > 0 ? "unpushed" : null;
    }

    const branchSyncStdout = yield* executeLenient(
      "WorktreeService.pruneWorktrees.branchSync",
      worktree.workspaceRoot,
      [
        "for-each-ref",
        `refs/heads/${status.branch}`,
        "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)",
      ],
    );
    if (branchSyncStdout === null) {
      return "status_unavailable";
    }

    const sync = parseBranchSyncInfo(branchSyncStdout).get(status.branch);
    if (sync === undefined) {
      return "status_unavailable";
    }
    if (sync.upstream !== null && !sync.upstreamGone) {
      if (sync.aheadOfUpstreamCount === null) {
        return "status_unavailable";
      }
      return sync.aheadOfUpstreamCount > 0 ? "unpushed" : null;
    }

    const defaultRef = yield* resolveDefaultRef(worktree.workspaceRoot);
    if (defaultRef === null) {
      return "status_unavailable";
    }
    const aheadOfDefaultCount = yield* countAheadOfDefault(
      worktree.workspaceRoot,
      `refs/heads/${status.branch}`,
      defaultRef,
    );
    if (aheadOfDefaultCount === null) {
      return "status_unavailable";
    }
    return aheadOfDefaultCount > 0 ? "unpushed" : null;
  });

  /** Working-tree change count from one `git status` call; null when status
      cannot be read. The inventory does not need the diffs and remote lookups
      that statusDetails also performs, and they dominate its cost. */
  const readWorkingTreeChanges = Effect.fn("WorktreeService.readWorkingTreeChanges")(
    function* (worktreePath: string) {
      const stdout = yield* executeLenient("WorktreeService.readWorkingTreeChanges", worktreePath, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=normal",
      ]);
      if (stdout === null) return { dirty: null, dirtyFileCount: null };
      const tokens = stdout.split("\0");
      let count = 0;
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === undefined || token.length === 0) continue;
        count += 1;
        // Renames and copies carry the original path as the following token.
        if (token[0] === "R" || token[0] === "C" || token[1] === "R" || token[1] === "C") {
          index += 1;
        }
      }
      return { dirty: count > 0, dirtyFileCount: count };
    },
    // Interrupts propagate; anything else degrades this row to unknown status.
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.gen(function* () {
            yield* Effect.logWarning("worktrees.inventory.status-failed", { cause });
            return { dirty: null, dirtyFileCount: null };
          }),
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
    shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) {
    const primaryProject = group.projects[0];
    if (primaryProject === undefined) return [] as WorktreeInfo[];

    // The workspace listing, branch sync counters, and default ref only need
    // the group root, so they run together instead of as three spawn rounds.
    const [entries, branchSyncStdout, defaultRef] = yield* Effect.all(
      [
        git.listWorkspaces(group.canonicalWorkspaceRoot).pipe(
          Effect.flatMap((rawEntries) =>
            Effect.forEach(rawEntries, (entry) =>
              canonicalizePath(entry.path).pipe(
                Effect.map((canonicalPath) => ({ ...entry, path: canonicalPath })),
              ),
            ),
          ),
          Effect.map((rawEntries) =>
            rawEntries.filter((entry) => isPathInside(managedWorktreesRoot, entry.path, path)),
          ),
        ),
        executeLenient("WorktreeService.listGroup.branchSync", group.canonicalWorkspaceRoot, [
          "for-each-ref",
          "refs/heads",
          "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)",
        ]),
        resolveDefaultRef(group.canonicalWorkspaceRoot),
      ],
      { concurrency: 3 },
    );
    if (entries.length === 0) return [] as WorktreeInfo[];

    const projectIds = new Set(group.projects.map((project) => project.id));
    const threadsByPath = new Map<string, OrchestrationV2ThreadShell[]>();
    for (const thread of shells) {
      if (!projectIds.has(thread.projectId) || thread.worktreePath === null) continue;
      const resolvedPath = yield* canonicalizePath(thread.worktreePath);
      const bucket = threadsByPath.get(resolvedPath);
      if (bucket === undefined) {
        threadsByPath.set(resolvedPath, [thread]);
      } else {
        bucket.push(thread);
      }
    }

    const branchSyncUnavailable = branchSyncStdout === null;
    const branchSync = parseBranchSyncInfo(branchSyncStdout ?? "");

    return yield* Effect.forEach(
      entries,
      (entry) =>
        Effect.gen(function* () {
          const linkedThreads = threadsByPath.get(entry.path) ?? [];
          const threadRefs: WorktreeThreadRef[] = linkedThreads.map((thread) => ({
            threadId: thread.id,
            title: thread.title,
            status: threadStatus(thread),
          }));
          const primaryThreadActivity = latestIsoTimestamp(
            linkedThreads
              .filter((thread) => thread.deletedAt === null)
              .map((thread) => DateTime.formatIso(thread.updatedAt)),
          );
          const lastActivityAt =
            primaryThreadActivity ??
            latestIsoTimestamp(
              linkedThreads.map((thread) => DateTime.formatIso(thread.updatedAt)),
            ) ??
            (yield* worktreeMtime(entry.path));

          const sync = entry.refName === null ? undefined : branchSync.get(entry.refName);
          const upstreamUnavailable =
            branchSyncUnavailable || (entry.refName !== null && sync === undefined);
          const hasUpstream = upstreamUnavailable
            ? null
            : sync?.upstream !== null && sync !== undefined;
          const upstreamGone = sync?.upstreamGone ?? false;
          const aheadOfUpstreamCount = sync?.aheadOfUpstreamCount ?? null;
          const behindUpstreamCount = sync?.behindUpstreamCount ?? null;

          const [status, aheadOfDefaultCount] = yield* Effect.all(
            [
              readWorkingTreeChanges(entry.path),
              defaultRef === null
                ? Effect.succeed(null)
                : entry.refName === null
                  ? countAheadOfDefault(entry.path, "HEAD", defaultRef)
                  : countAheadOfDefault(
                      group.canonicalWorkspaceRoot,
                      `refs/heads/${entry.refName}`,
                      defaultRef,
                    ),
            ],
            { concurrency: 2 },
          );

          const blockers = new Set<WorktreePruneBlocker>();
          if (threadRefs.some((thread) => thread.status === "active")) {
            blockers.add("active_thread");
          }
          if (status.dirty === true) {
            blockers.add("dirty");
          } else if (status.dirty === null) {
            blockers.add("status_unavailable");
          }
          if (entry.refName !== null && upstreamUnavailable) {
            blockers.add("status_unavailable");
          } else if (
            entry.refName !== null &&
            sync?.upstream !== null &&
            sync !== undefined &&
            !sync.upstreamGone
          ) {
            if (aheadOfUpstreamCount === null) {
              blockers.add("status_unavailable");
            } else if (aheadOfUpstreamCount > 0) {
              blockers.add("unpushed");
            }
          } else if (aheadOfDefaultCount === null) {
            // A branch with no usable upstream, or a detached HEAD, is only
            // safe once its commits can be compared with the default ref.
            blockers.add("status_unavailable");
          } else if (aheadOfDefaultCount > 0) {
            blockers.add("unpushed");
          }

          const projects: WorktreeProjectRef[] = group.projects.map((project) => ({
            projectId: project.id,
            projectTitle: project.title,
            workspaceRoot: project.workspaceRoot,
          }));

          return {
            projectId: primaryProject.id,
            projectTitle: primaryProject.title,
            workspaceRoot: primaryProject.workspaceRoot,
            projects,
            path: entry.path,
            branch: entry.refName,
            threads: threadRefs,
            orphaned: threadRefs.every((thread) => thread.status === "deleted"),
            dirty: status.dirty,
            dirtyFileCount: status.dirtyFileCount,
            hasUpstream,
            upstreamGone,
            aheadOfUpstreamCount,
            behindUpstreamCount,
            aheadOfDefaultCount,
            lastActivityAt,
            safeToPrune: blockers.size === 0,
            pruneBlockers: [...blockers],
          } satisfies WorktreeInfo;
        }),
      { concurrency: WORKTREE_STATUS_CONCURRENCY },
    );
  });

  const listWorktrees: WorktreeService["Service"]["listWorktrees"] = Effect.fn(
    "WorktreeService.listWorktrees",
  )(function* (input) {
    const projectSnapshot = yield* projectsService.snapshot.pipe(
      Effect.mapError((cause) => inventoryError("load_projects", cause)),
    );
    const shellSnapshot = yield* threadManagement
      .getShellSnapshot()
      .pipe(Effect.mapError((cause) => inventoryError("load_threads", cause)));

    const normalizedProjects = yield* Effect.forEach(
      projectSnapshot.projects,
      (project) =>
        Effect.gen(function* () {
          const canonicalWorkspaceRoot = yield* canonicalizePath(project.workspaceRoot);
          const commonDir = yield* executeLenient(
            "WorktreeService.listWorktrees.repositoryKey",
            canonicalWorkspaceRoot,
            ["rev-parse", "--git-common-dir"],
          ).pipe(
            Effect.mapError((cause) =>
              inventoryError("identify_repository", cause, {
                projectId: project.id,
                workspaceRoot: canonicalWorkspaceRoot,
              }),
            ),
          );
          // A project outside any Git repository has no worktrees to list;
          // skip it rather than fail the inventory for every other project.
          if (commonDir === null) return null;
          const repositoryKey =
            commonDir.trim().length === 0
              ? canonicalWorkspaceRoot
              : yield* canonicalizePath(path.resolve(canonicalWorkspaceRoot, commonDir.trim()));
          return {
            id: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
            canonicalWorkspaceRoot,
            repositoryKey,
          };
        }),
      { concurrency: PROJECT_SCAN_CONCURRENCY },
    ).pipe(Effect.map((projects) => projects.filter((project) => project !== null)));
    const selectedRepositoryKeys =
      input.projectId === undefined
        ? null
        : new Set(
            normalizedProjects
              .filter((project) => project.id === input.projectId)
              .map((project) => project.repositoryKey),
          );

    const groups = new Map<string, ProjectGroup>();
    for (const project of normalizedProjects) {
      if (selectedRepositoryKeys !== null && !selectedRepositoryKeys.has(project.repositoryKey)) {
        continue;
      }
      const existing = groups.get(project.repositoryKey);
      if (existing === undefined) {
        groups.set(project.repositoryKey, {
          canonicalWorkspaceRoot: project.canonicalWorkspaceRoot,
          projects: [project],
        });
      } else {
        groups.set(project.repositoryKey, {
          ...existing,
          projects: [...existing.projects, project],
        });
      }
    }

    const records = yield* Effect.forEach(
      [...groups.values()],
      (group) =>
        listGroup(group, [...shellSnapshot.threads, ...shellSnapshot.archivedThreads]).pipe(
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
    return { worktrees };
  });

  const pruneWorktreesUnlocked = Effect.fn("WorktreeService.pruneWorktrees")(function* (
    input: VcsPruneWorktreesInput,
    options?: { readonly requireOrphaned?: boolean },
  ) {
    // Re-derive the inventory so safety reflects the current state, never a
    // stale client view. Git's non-forced remove is a second safety boundary.
    const { worktrees } = yield* listWorktrees({}).pipe(
      Effect.mapError(
        (cause) =>
          new WorktreeMutationError({
            operation: "prune",
            stage: "revalidate_inventory",
            cause,
          }),
      ),
    );
    const byPath = new Map(worktrees.map((worktree) => [worktree.path, worktree]));
    const removed: Array<{ path: string; workspaceRoot: string }> = [];
    const skipped: Array<{
      path: string;
      reason: WorktreePruneSkipReason;
      detail?: string;
    }> = [];
    const touchedRoots = new Set<string>();
    const processedPaths = new Set<string>();

    for (const requestedPath of input.paths) {
      const canonicalPath = yield* canonicalizePath(requestedPath);
      if (processedPaths.has(canonicalPath)) continue;
      processedPaths.add(canonicalPath);

      const worktree = byPath.get(canonicalPath);
      if (worktree === undefined) {
        skipped.push({ path: requestedPath, reason: "unknown_worktree" });
        continue;
      }
      // Thread deletion cleanup is allowed to remove only an orphan. This is
      // deliberately checked on the fresh inventory above so a worktree that
      // became shared after the deletion event cannot be removed by a stale
      // observation.
      if (options?.requireOrphaned === true && !worktree.orphaned) {
        continue;
      }
      if (!worktree.safeToPrune) {
        skipped.push({
          path: worktree.path,
          reason: worktree.pruneBlockers[0] ?? "status_unavailable",
        });
        continue;
      }

      const freshBlocker = yield* freshPruneBlocker(worktree).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.gen(function* () {
                yield* Effect.logWarning("worktrees.prune.status-failed", {
                  worktreePath: worktree.path,
                  cause,
                });
                return "status_unavailable" as const;
              }),
        ),
      );
      if (freshBlocker !== null) {
        skipped.push({ path: worktree.path, reason: freshBlocker });
        continue;
      }

      // Threads can link to a worktree without taking the mutation permit
      // (branch carry-over, unsettle), so linkage is rechecked on a fresh
      // shell snapshot immediately before removal, like Git state above.
      const freshThreadCheck = yield* threadManagement.getShellSnapshot().pipe(
        Effect.flatMap((snapshot) =>
          Effect.gen(function* () {
            const references: WorktreeThreadStatus[] = [];
            for (const thread of [...snapshot.threads, ...snapshot.archivedThreads]) {
              if (thread.worktreePath === null) continue;
              const status = threadStatus(thread);
              if (status === "deleted") continue;
              const resolvedPath = yield* canonicalizePath(thread.worktreePath);
              if (resolvedPath === worktree.path) references.push(status);
            }
            return { ok: true as const, references };
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("worktrees.prune.thread-recheck-failed", {
            worktreePath: worktree.path,
            cause,
          }).pipe(Effect.as({ ok: false as const, references: [] as WorktreeThreadStatus[] })),
        ),
      );
      if (!freshThreadCheck.ok) {
        skipped.push({ path: worktree.path, reason: "status_unavailable" });
        continue;
      }
      if (options?.requireOrphaned === true && freshThreadCheck.references.length > 0) {
        continue;
      }
      if (freshThreadCheck.references.includes("active")) {
        skipped.push({ path: worktree.path, reason: "active_thread" });
        continue;
      }

      const removal = yield* git
        .removeWorktree({ cwd: worktree.workspaceRoot, path: worktree.path })
        .pipe(
          Effect.match({
            onFailure: (cause) => ({ ok: false as const, cause }),
            onSuccess: () => ({ ok: true as const }),
          }),
        );
      if (!removal.ok) {
        skipped.push({
          path: worktree.path,
          reason: "remove_failed",
          detail: removal.cause.message,
        });
        continue;
      }

      removed.push({ path: worktree.path, workspaceRoot: worktree.workspaceRoot });
      touchedRoots.add(worktree.workspaceRoot);
    }

    // Do not remove branches or checkpoint refs. This only clears stale Git
    // worktree registrations left by an already completed removal.
    yield* Effect.forEach(
      [...touchedRoots],
      (workspaceRoot) =>
        git
          .execute({
            operation: "WorktreeService.pruneWorktrees.gitPrune",
            cwd: workspaceRoot,
            args: ["worktree", "prune"],
            env: { LC_ALL: "C" },
            timeoutMs: 15_000,
          })
          .pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning("worktrees.prune.git-prune-failed", {
                workspaceRoot,
                cause,
              }),
            ),
          ),
      { concurrency: 1 },
    );

    if (removed.length > 0) {
      yield* lifecycle.markInventoryChanged;
      yield* Effect.logInfo("worktrees.pruned", {
        removedCount: removed.length,
        skippedCount: skipped.length,
        removedPaths: removed.map((entry) => entry.path),
      });
    }

    return { removed, skipped };
  });

  const pruneWorktrees = (input: VcsPruneWorktreesInput) =>
    lifecycle.withMutationPermit(pruneWorktreesUnlocked(input));
  const pruneOrphanedWorktree = (worktreePath: string) =>
    lifecycle.withMutationPermit(
      pruneWorktreesUnlocked({ paths: [worktreePath] }, { requireOrphaned: true }).pipe(
        Effect.map((result) => result.removed.length > 0),
      ),
    );
  return WorktreeService.of({
    listWorktrees,
    pruneWorktrees,
    pruneOrphanedWorktree,
  });
});

export const layer = Layer.effect(WorktreeService, make);
