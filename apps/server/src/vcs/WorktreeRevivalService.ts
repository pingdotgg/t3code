import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import {
  type ProjectId,
  type ThreadId,
  type WorktreeMutationErrorStage,
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

function mutationError(
  stage: WorktreeMutationErrorStage,
  cause?: unknown,
  context: {
    readonly path?: string;
    readonly conflictingPath?: string;
    readonly workspaceRoot?: string;
    readonly branch?: string;
    readonly projectId?: ProjectId;
  } = {},
): WorktreeMutationError {
  return new WorktreeMutationError({
    operation: "revive",
    stage,
    ...(context.path === undefined ? {} : { path: context.path }),
    ...(context.conflictingPath === undefined ? {} : { conflictingPath: context.conflictingPath }),
    ...(context.workspaceRoot === undefined ? {} : { workspaceRoot: context.workspaceRoot }),
    ...(context.branch === undefined ? {} : { branch: context.branch }),
    ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
    ...(cause === undefined ? {} : { cause }),
  });
}

export interface WorktreeRevivalForThreadInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly worktreePath: string;
  readonly branch: string;
}

interface WorktreeRevivalInput {
  readonly workspaceRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
}

interface WorktreeRevivalResult {
  readonly revived: boolean;
}

export class WorktreeRevivalService extends Context.Service<
  WorktreeRevivalService,
  {
    readonly reviveWorktree: (
      input: WorktreeRevivalInput,
    ) => Effect.Effect<WorktreeRevivalResult, WorktreeMutationError>;
    readonly reviveForThread: (
      input: WorktreeRevivalForThreadInput,
    ) => Effect.Effect<
      WorktreeRevivalResult & { readonly generation: number },
      WorktreeMutationError
    >;
  }
>()("t3/vcs/WorktreeRevivalService") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const lifecycle = yield* WorktreeLifecycle.WorktreeLifecycle;
  const projectsService = yield* ProjectService.ProjectService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const generationByWorktreePath = yield* Ref.make(new Map<string, number>());
  const setupGenerationByProjectWorktree = yield* Ref.make(new Map<string, number>());

  const currentGeneration = (worktreePath: string) =>
    Ref.get(generationByWorktreePath).pipe(
      Effect.map((generations) => generations.get(worktreePath) ?? 0),
    );
  const advanceGeneration = (worktreePath: string) =>
    Ref.modify(generationByWorktreePath, (generations) => {
      const generation = (generations.get(worktreePath) ?? 0) + 1;
      const next = new Map(generations);
      next.set(worktreePath, generation);
      return [generation, next] as const;
    });

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
          mutationError("inspect_target_path", cause, {
            path: value,
            ...context,
          }),
        ),
      ))
    ) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        return yield* mutationError("resolve_target_path", undefined, {
          path: value,
          ...context,
        });
      }
      unresolvedSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }

    const canonicalAncestor = yield* fs.realPath(existingAncestor).pipe(
      Effect.mapError((cause) =>
        mutationError("resolve_target_path", cause, {
          path: value,
          ...context,
        }),
      ),
    );
    return path.resolve(canonicalAncestor, ...unresolvedSegments);
  });

  const resolveManagedWorkspaceRoot = Effect.fn(
    "WorktreeRevivalService.resolveManagedWorkspaceRoot",
  )(function* (input: WorktreeRevivalInput) {
    const requestedWorkspaceRoot = yield* canonicalizePath(input.workspaceRoot);
    const projectSnapshot = yield* projectsService.snapshot.pipe(
      Effect.mapError((cause) =>
        mutationError("load_projects", cause, {
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
      return yield* mutationError("unmanaged_workspace", undefined, {
        workspaceRoot: requestedWorkspaceRoot,
        branch: input.branch,
      });
    }
    return requestedWorkspaceRoot;
  });

  const listCanonicalWorkspaces = Effect.fn("WorktreeRevivalService.listCanonicalWorkspaces")(
    function* (workspaceRoot: string, branch: string) {
      const entries = yield* git.listWorkspaces(workspaceRoot).pipe(
        Effect.mapError((cause) =>
          mutationError("inspect_registrations", cause, {
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
          mutationError("validate_branch", cause, {
            workspaceRoot,
            branch,
          }),
        ),
      );
    if (branchFormat.exitCode !== 0) {
      return yield* mutationError("invalid_branch", undefined, { workspaceRoot, branch });
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
          mutationError("check_branch", cause, {
            workspaceRoot,
            branch,
          }),
        ),
      );
    if (branchExists.exitCode !== 0) {
      return yield* mutationError("missing_branch", undefined, { workspaceRoot, branch });
    }
  });

  const reviveWorktreeUnlocked = Effect.fn("WorktreeRevivalService.reviveWorktree")(function* (
    input: WorktreeRevivalInput,
  ) {
    const workspaceRoot = yield* resolveManagedWorkspaceRoot(input);
    const worktreePath = yield* resolveEffectiveDestination(input.worktreePath, {
      workspaceRoot,
      branch: input.branch,
    });
    if (!isPathInside(managedWorktreesRoot, worktreePath, path)) {
      return yield* mutationError("outside_managed_root", undefined, {
        path: worktreePath,
        workspaceRoot,
        branch: input.branch,
      });
    }

    const exists = yield* fs.exists(worktreePath).pipe(
      Effect.mapError((cause) =>
        mutationError("inspect_target_path", cause, {
          path: worktreePath,
          workspaceRoot,
          branch: input.branch,
        }),
      ),
    );
    let registrations = yield* listCanonicalWorkspaces(workspaceRoot, input.branch);
    let targetRegistration = registrations.find((entry) => entry.path === worktreePath);

    if (targetRegistration !== undefined && targetRegistration.refName !== input.branch) {
      return yield* mutationError("registered_different_ref", undefined, {
        path: worktreePath,
        workspaceRoot,
        branch: input.branch,
      });
    }

    if (exists) {
      if (targetRegistration === undefined) {
        return yield* mutationError("unregistered_existing_path", undefined, {
          path: worktreePath,
          workspaceRoot,
          branch: input.branch,
        });
      }
      if (targetRegistration.prunable) {
        return yield* mutationError("stale_existing_registration", undefined, {
          path: worktreePath,
          workspaceRoot,
          branch: input.branch,
        });
      }
      return {
        revived: false,
        generation: yield* currentGeneration(worktreePath),
        worktreePath,
      };
    }

    const branchRegisteredElsewhere = registrations.find(
      (entry) => entry.refName === input.branch && entry.path !== worktreePath && !entry.prunable,
    );
    if (branchRegisteredElsewhere !== undefined) {
      return yield* mutationError("branch_in_use", undefined, {
        path: worktreePath,
        conflictingPath: branchRegisteredElsewhere.path,
        workspaceRoot,
        branch: input.branch,
      });
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
            mutationError("prune_metadata", cause, {
              path: worktreePath,
              workspaceRoot,
              branch: input.branch,
            }),
          ),
        );
      registrations = yield* listCanonicalWorkspaces(workspaceRoot, input.branch);
      targetRegistration = registrations.find((entry) => entry.path === worktreePath);
      if (targetRegistration !== undefined) {
        return yield* mutationError("stale_registration_remaining", undefined, {
          path: worktreePath,
          workspaceRoot,
          branch: input.branch,
        });
      }
      const branchStillRegisteredElsewhere = registrations.find(
        (entry) => entry.refName === input.branch && entry.path !== worktreePath && !entry.prunable,
      );
      if (branchStillRegisteredElsewhere !== undefined) {
        return yield* mutationError("branch_in_use", undefined, {
          path: worktreePath,
          conflictingPath: branchStillRegisteredElsewhere.path,
          workspaceRoot,
          branch: input.branch,
        });
      }
    }

    const existsAfterPrune = yield* fs.exists(worktreePath).pipe(
      Effect.mapError((cause) =>
        mutationError("inspect_target_path", cause, {
          path: worktreePath,
          workspaceRoot,
          branch: input.branch,
        }),
      ),
    );
    if (existsAfterPrune) {
      return yield* mutationError("target_appeared", undefined, {
        path: worktreePath,
        workspaceRoot,
        branch: input.branch,
      });
    }

    yield* validateBranchExists(workspaceRoot, input.branch);
    const generation = yield* Effect.uninterruptibleMask((restore) =>
      restore(
        git.createWorktree({ cwd: workspaceRoot, refName: input.branch, path: worktreePath }).pipe(
          Effect.mapError((cause) =>
            mutationError("create_worktree", cause, {
              path: worktreePath,
              workspaceRoot,
              branch: input.branch,
            }),
          ),
        ),
      ).pipe(
        Effect.andThen(advanceGeneration(worktreePath)),
        Effect.tap(() => lifecycle.markInventoryChanged),
      ),
    );

    const finalExists = yield* fs.exists(worktreePath).pipe(
      Effect.mapError((cause) =>
        mutationError("verify_worktree", cause, {
          path: worktreePath,
          workspaceRoot,
          branch: input.branch,
        }),
      ),
    );
    const finalRegistrations = yield* listCanonicalWorkspaces(workspaceRoot, input.branch);
    const finalRegistration = finalRegistrations.find((entry) => entry.path === worktreePath);
    if (!finalExists || finalRegistration?.refName !== input.branch || finalRegistration.prunable) {
      return yield* mutationError("worktree_verification_failed", undefined, {
        path: worktreePath,
        workspaceRoot,
        branch: input.branch,
      });
    }

    yield* Effect.logInfo("worktree.revived", {
      worktreePath,
      branch: input.branch,
    });
    return { revived: true, generation, worktreePath };
  });

  const reviveWorktree = (input: WorktreeRevivalInput) =>
    lifecycle
      .withMutationPermit(reviveWorktreeUnlocked(input))
      .pipe(Effect.map(({ revived }) => ({ revived })));

  const reviveForThreadUnlocked = Effect.fn("WorktreeRevivalService.reviveForThread")(function* (
    input: WorktreeRevivalForThreadInput,
  ) {
    const project = yield* projectsService.getById(input.projectId).pipe(
      Effect.mapError((cause) =>
        mutationError("load_project", cause, {
          path: input.worktreePath,
          branch: input.branch,
          projectId: input.projectId,
        }),
      ),
    );
    if (Option.isNone(project)) {
      return yield* mutationError("project_not_found", undefined, {
        path: input.worktreePath,
        branch: input.branch,
        projectId: input.projectId,
      });
    }
    const revival = yield* reviveWorktreeUnlocked({
      workspaceRoot: project.value.workspaceRoot,
      worktreePath: input.worktreePath,
      branch: input.branch,
    });
    const setupGenerationKey = `${input.projectId}\0${revival.worktreePath}`;
    const setupGeneration = (yield* Ref.get(setupGenerationByProjectWorktree)).get(
      setupGenerationKey,
    );
    if (revival.generation > 0 && setupGeneration !== revival.generation) {
      yield* setupScripts
        .runForThread({
          threadId: input.threadId,
          projectId: input.projectId,
          projectCwd: project.value.workspaceRoot,
          worktreePath: revival.worktreePath,
          project: {
            workspaceRoot: project.value.workspaceRoot,
            scripts: project.value.scripts,
          },
        })
        .pipe(
          Effect.mapError((cause) =>
            mutationError("run_setup", cause, {
              path: input.worktreePath,
              workspaceRoot: project.value.workspaceRoot,
              branch: input.branch,
            }),
          ),
        );
      yield* Ref.update(setupGenerationByProjectWorktree, (generations) => {
        const next = new Map(generations);
        next.set(setupGenerationKey, revival.generation);
        return next;
      });
    }
    return { revived: revival.revived, generation: revival.generation };
  });
  const reviveForThread: WorktreeRevivalService["Service"]["reviveForThread"] = (input) =>
    lifecycle.withMutationPermit(reviveForThreadUnlocked(input));

  return WorktreeRevivalService.of({ reviveWorktree, reviveForThread });
});

export const layer = Layer.effect(WorktreeRevivalService, make);
