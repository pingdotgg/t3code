import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  type ProjectId,
  type ThreadId,
  type VcsReviveWorktreeInput,
  type VcsReviveWorktreeResult,
  WorktreeMutationError,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as WorktreeLifecycle from "./WorktreeLifecycle.ts";

const PROJECT_SCAN_CONCURRENCY = 4;

function isPathInside(
  root: string,
  candidate: string,
  path: {
    readonly relative: (from: string, to: string) => string;
    readonly isAbsolute: (value: string) => boolean;
  },
): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function mutationError(
  message: string,
  cause?: unknown,
  context: {
    readonly path?: string;
    readonly workspaceRoot?: string;
    readonly branch?: string;
  } = {},
): WorktreeMutationError {
  return new WorktreeMutationError({
    operation: "revive",
    message,
    ...(context.path === undefined ? {} : { path: context.path }),
    ...(context.workspaceRoot === undefined ? {} : { workspaceRoot: context.workspaceRoot }),
    ...(context.branch === undefined ? {} : { branch: context.branch }),
    ...(cause === undefined ? {} : { cause }),
  });
}

export interface WorktreeRevivalServiceShape {
  readonly reviveWorktree: (
    input: VcsReviveWorktreeInput,
  ) => Effect.Effect<VcsReviveWorktreeResult, WorktreeMutationError>;
  readonly reviveForThread: (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly worktreePath: string;
    readonly branch: string;
  }) => Effect.Effect<VcsReviveWorktreeResult, WorktreeMutationError>;
}

export class WorktreeRevivalService extends Context.Service<
  WorktreeRevivalService,
  WorktreeRevivalServiceShape
>()("t3/vcs/WorktreeRevivalService") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const lifecycle = yield* WorktreeLifecycle.WorktreeLifecycle;
  const projectsService = yield* ProjectService.ProjectService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;

  // Canonicalize through symlinks so configured roots, Git metadata, and V2
  // thread paths compare equal on hosts such as macOS (/var vs /private/var).
  const canonicalizePath = (value: string) =>
    fs.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));
  const managedWorktreesRoot = yield* canonicalizePath(config.worktreesDir);

  const resolveEffectiveDestination = Effect.fn(
    "WorktreeRevivalService.resolveEffectiveDestination",
  )(function* (
    value: string,
    context: {
      readonly workspaceRoot: string;
      readonly branch: string;
    },
  ) {
    const unresolvedSegments: string[] = [];
    let existingAncestor = path.resolve(value);

    while (
      !(yield* fs.exists(existingAncestor).pipe(
        Effect.mapError((cause) =>
          mutationError("Failed to inspect the target worktree path.", cause, {
            path: value,
            ...context,
          }),
        ),
      ))
    ) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        return yield* mutationError(
          `Cannot resolve an existing ancestor for worktree path '${value}'.`,
          undefined,
          { path: value, ...context },
        );
      }
      unresolvedSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }

    const canonicalAncestor = yield* fs.realPath(existingAncestor).pipe(
      Effect.mapError((cause) =>
        mutationError("Failed to resolve the target worktree path.", cause, {
          path: value,
          ...context,
        }),
      ),
    );
    return path.resolve(canonicalAncestor, ...unresolvedSegments);
  });

  const resolveManagedWorkspaceRoot = Effect.fn(
    "WorktreeRevivalService.resolveManagedWorkspaceRoot",
  )(function* (input: VcsReviveWorktreeInput) {
    const requestedWorkspaceRoot = yield* canonicalizePath(input.workspaceRoot);
    const projectSnapshot = yield* projectsService.snapshot.pipe(
      Effect.mapError((cause) =>
        mutationError("Failed to load projects before reviving the worktree.", cause, {
          workspaceRoot: requestedWorkspaceRoot,
          branch: input.branch,
        }),
      ),
    );
    const projectRoots = yield* Effect.forEach(
      projectSnapshot.projects,
      (project) => canonicalizePath(project.workspaceRoot),
      { concurrency: PROJECT_SCAN_CONCURRENCY },
    );
    if (!projectRoots.includes(requestedWorkspaceRoot)) {
      return yield* mutationError(
        `Cannot revive a worktree for unmanaged workspace '${input.workspaceRoot}'.`,
        undefined,
        { workspaceRoot: requestedWorkspaceRoot, branch: input.branch },
      );
    }
    return requestedWorkspaceRoot;
  });

  const listCanonicalWorkspaces = Effect.fn("WorktreeRevivalService.listCanonicalWorkspaces")(
    function* (workspaceRoot: string, branch: string) {
      const entries = yield* git.listWorkspaces(workspaceRoot).pipe(
        Effect.mapError((cause) =>
          mutationError("Failed to inspect Git worktree registrations.", cause, {
            workspaceRoot,
            branch,
          }),
        ),
      );
      return yield* Effect.forEach(entries, (entry) =>
        canonicalizePath(entry.path).pipe(Effect.map((path) => ({ ...entry, path }))),
      );
    },
  );

  const validateBranchExists = Effect.fn("WorktreeRevivalService.validateBranchExists")(function* (
    workspaceRoot: string,
    branch: string,
  ) {
    const branchFormat = yield* git
      .execute({
        operation: "WorktreeRevivalService.validateBranch",
        cwd: workspaceRoot,
        args: ["check-ref-format", "--branch", branch],
        env: { LC_ALL: "C" },
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      })
      .pipe(
        Effect.mapError((cause) =>
          mutationError("Failed to validate the worktree branch.", cause, {
            workspaceRoot,
            branch,
          }),
        ),
      );
    if (branchFormat.exitCode !== 0) {
      return yield* mutationError(
        `Cannot revive the worktree: '${branch}' is not a valid local branch name.`,
        undefined,
        { workspaceRoot, branch },
      );
    }

    const branchExists = yield* git
      .execute({
        operation: "WorktreeRevivalService.branchExists",
        cwd: workspaceRoot,
        args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        env: { LC_ALL: "C" },
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      })
      .pipe(
        Effect.mapError((cause) =>
          mutationError("Failed to check whether the worktree branch exists.", cause, {
            workspaceRoot,
            branch,
          }),
        ),
      );
    if (branchExists.exitCode !== 0) {
      return yield* mutationError(
        `Cannot recreate the worktree: branch '${branch}' no longer exists.`,
        undefined,
        { workspaceRoot, branch },
      );
    }
  });

  const reviveWorktreeUnlocked: WorktreeRevivalServiceShape["reviveWorktree"] = Effect.fn(
    "WorktreeRevivalService.reviveWorktree",
  )(function* (input) {
    const workspaceRoot = yield* resolveManagedWorkspaceRoot(input);
    const worktreePath = yield* resolveEffectiveDestination(input.worktreePath, {
      workspaceRoot,
      branch: input.branch,
    });
    if (!isPathInside(managedWorktreesRoot, worktreePath, path)) {
      return yield* mutationError(
        `Cannot revive a worktree outside the managed worktrees directory: '${input.worktreePath}'.`,
        undefined,
        { path: worktreePath, workspaceRoot, branch: input.branch },
      );
    }

    const exists = yield* fs.exists(worktreePath).pipe(
      Effect.mapError((cause) =>
        mutationError("Failed to inspect the target worktree path.", cause, {
          path: worktreePath,
          workspaceRoot,
          branch: input.branch,
        }),
      ),
    );
    let registrations = yield* listCanonicalWorkspaces(workspaceRoot, input.branch);
    let targetRegistration = registrations.find((entry) => entry.path === worktreePath);

    if (targetRegistration !== undefined && targetRegistration.refName !== input.branch) {
      return yield* mutationError(
        `Cannot revive '${input.worktreePath}': Git already registers that path for a different ref.`,
        undefined,
        { path: worktreePath, workspaceRoot, branch: input.branch },
      );
    }

    if (exists) {
      if (targetRegistration === undefined) {
        return yield* mutationError(
          `Cannot revive '${input.worktreePath}': the directory exists but is not a registered Git worktree.`,
          undefined,
          { path: worktreePath, workspaceRoot, branch: input.branch },
        );
      }
      if (targetRegistration.prunable) {
        return yield* mutationError(
          `Cannot revive '${input.worktreePath}': the existing directory has a stale Git worktree registration.`,
          undefined,
          { path: worktreePath, workspaceRoot, branch: input.branch },
        );
      }
      return { revived: false };
    }

    const branchRegisteredElsewhere = registrations.find(
      (entry) => entry.refName === input.branch && entry.path !== worktreePath && !entry.prunable,
    );
    if (branchRegisteredElsewhere !== undefined) {
      return yield* mutationError(
        `Cannot revive branch '${input.branch}': it is already checked out at '${branchRegisteredElsewhere.path}'.`,
        undefined,
        { path: worktreePath, workspaceRoot, branch: input.branch },
      );
    }

    // A deleted directory can leave a stale registration in Git's metadata.
    // Prune only stale registrations, then inspect the registration table
    // again before creating anything at the requested path.
    const needsGitPrune =
      targetRegistration !== undefined || registrations.some((entry) => entry.prunable);
    if (needsGitPrune) {
      yield* git
        .execute({
          operation: "WorktreeRevivalService.prune",
          cwd: workspaceRoot,
          args: ["worktree", "prune"],
          env: { LC_ALL: "C" },
          timeoutMs: 15_000,
        })
        .pipe(
          Effect.mapError((cause) =>
            mutationError("Failed to clear stale Git worktree metadata.", cause, {
              path: worktreePath,
              workspaceRoot,
              branch: input.branch,
            }),
          ),
        );
      registrations = yield* listCanonicalWorkspaces(workspaceRoot, input.branch);
      targetRegistration = registrations.find((entry) => entry.path === worktreePath);
      if (targetRegistration !== undefined) {
        return yield* mutationError(
          `Cannot revive '${input.worktreePath}': Git still has a worktree registration at that path.`,
          undefined,
          { path: worktreePath, workspaceRoot, branch: input.branch },
        );
      }
      const branchStillRegisteredElsewhere = registrations.find(
        (entry) => entry.refName === input.branch && entry.path !== worktreePath && !entry.prunable,
      );
      if (branchStillRegisteredElsewhere !== undefined) {
        return yield* mutationError(
          `Cannot revive branch '${input.branch}': it is already checked out at '${branchStillRegisteredElsewhere.path}'.`,
          undefined,
          { path: worktreePath, workspaceRoot, branch: input.branch },
        );
      }
    }

    const existsAfterPrune = yield* fs.exists(worktreePath).pipe(
      Effect.mapError((cause) =>
        mutationError("Failed to recheck the target worktree path.", cause, {
          path: worktreePath,
          workspaceRoot,
          branch: input.branch,
        }),
      ),
    );
    if (existsAfterPrune) {
      return yield* mutationError(
        `Cannot revive '${input.worktreePath}': the target directory appeared before creation.`,
        undefined,
        { path: worktreePath, workspaceRoot, branch: input.branch },
      );
    }

    yield* validateBranchExists(workspaceRoot, input.branch);
    yield* git
      .createWorktree({ cwd: workspaceRoot, refName: input.branch, path: worktreePath })
      .pipe(
        Effect.mapError((cause) =>
          mutationError("Failed to create the revived Git worktree.", cause, {
            path: worktreePath,
            workspaceRoot,
            branch: input.branch,
          }),
        ),
      );

    const finalExists = yield* fs.exists(worktreePath).pipe(
      Effect.mapError((cause) =>
        mutationError("Failed to verify the revived worktree directory.", cause, {
          path: worktreePath,
          workspaceRoot,
          branch: input.branch,
        }),
      ),
    );
    const finalRegistrations = yield* listCanonicalWorkspaces(workspaceRoot, input.branch);
    const finalRegistration = finalRegistrations.find((entry) => entry.path === worktreePath);
    if (!finalExists || finalRegistration?.refName !== input.branch || finalRegistration.prunable) {
      return yield* mutationError(
        `The worktree was created but could not be verified at '${input.worktreePath}'.`,
        undefined,
        { path: worktreePath, workspaceRoot, branch: input.branch },
      );
    }

    yield* Effect.logInfo("worktree.revived", {
      worktreePath,
      branch: input.branch,
    });
    yield* lifecycle.markInventoryChanged;
    return { revived: true };
  });

  const reviveWorktree = (input: VcsReviveWorktreeInput) =>
    lifecycle.withMutationPermit(reviveWorktreeUnlocked(input));

  const reviveForThread: WorktreeRevivalServiceShape["reviveForThread"] = Effect.fn(
    "WorktreeRevivalService.reviveForThread",
  )(function* (input) {
    const project = yield* projectsService.getById(input.projectId).pipe(
      Effect.mapError((cause) =>
        mutationError("Failed to load the project before reviving the worktree.", cause, {
          path: input.worktreePath,
          branch: input.branch,
        }),
      ),
    );
    if (Option.isNone(project)) {
      return yield* mutationError(
        `Cannot revive a worktree for project '${input.projectId}': the project was not found.`,
        undefined,
        { path: input.worktreePath, branch: input.branch },
      );
    }
    const revival = yield* reviveWorktree({
      workspaceRoot: project.value.workspaceRoot,
      worktreePath: input.worktreePath,
      branch: input.branch,
    });
    if (revival.revived) {
      yield* setupScripts
        .runForThread({
          threadId: input.threadId,
          projectId: input.projectId,
          projectCwd: project.value.workspaceRoot,
          worktreePath: input.worktreePath,
          project: {
            workspaceRoot: project.value.workspaceRoot,
            scripts: project.value.scripts,
          },
        })
        .pipe(
          Effect.mapError((cause) =>
            mutationError("Failed to run the project setup script after revival.", cause, {
              path: input.worktreePath,
              workspaceRoot: project.value.workspaceRoot,
              branch: input.branch,
            }),
          ),
        );
    }
    return revival;
  });

  return WorktreeRevivalService.of({ reviveWorktree, reviveForThread });
});

export const layer = Layer.effect(WorktreeRevivalService, make);
