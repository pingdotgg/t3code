import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const lifecycle = yield* WorktreeLifecycle.WorktreeLifecycle;
  const projectsService = yield* ProjectService.ProjectService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const generationByWorktreePath = yield* Ref.make(new Map<string, number>());
  // Project setup for a recreated worktree: one run per project, worktree, and
  // generation, shared by every turn start that needs it.
  const setupRuns = yield* Ref.make(
    new Map<
      string,
      {
        readonly generation: number;
        readonly outcome: Deferred.Deferred<void, WorktreeMutationError>;
      }
    >(),
  );
  // Setup runs are forked here so they outlive the turn start that began them.
  const serviceScope = yield* Effect.scope;

  const setupKey = (projectId: ProjectId, worktreePath: string) => `${projectId}\0${worktreePath}`;
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
    const exists = yield* fs.exists(worktreePath).pipe(
      Effect.mapError((cause) =>
        mutationError("inspect_target_path", cause, {
          path: worktreePath,
          workspaceRoot,
          branch: input.branch,
        }),
      ),
    );
    // An existing directory is left alone wherever it lives and whatever it
    // has checked out. A detached HEAD after a stopped rebase or a switched
    // branch is working state the thread runs in, not damage to repair. The
    // checks below only guard creating a worktree that went missing.
    if (exists) {
      return {
        revived: false,
        generation: yield* currentGeneration(worktreePath),
        worktreePath,
      };
    }
    if (!isPathInside(managedWorktreesRoot, worktreePath, path)) {
      return yield* mutationError("outside_managed_root", undefined, {
        path: worktreePath,
        workspaceRoot,
        branch: input.branch,
      });
    }

    let registrations = yield* listCanonicalWorkspaces(workspaceRoot, input.branch);
    let targetRegistration = registrations.find((entry) => entry.path === worktreePath);

    if (targetRegistration !== undefined && targetRegistration.refName !== input.branch) {
      return yield* mutationError("registered_different_ref", undefined, {
        path: worktreePath,
        workspaceRoot,
        branch: input.branch,
      });
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

  const loadProject = Effect.fn("WorktreeRevivalService.loadProject")(function* (
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
    return project.value;
  });

  /**
   * Runs the project's setup script in a recreated worktree and resolves
   * `outcome` once the agent may start. As at thread launch, an async script
   * only has to start, while a script marked `async: false` has to exit 0.
   */
  const runSetup = Effect.fn("WorktreeRevivalService.runSetup")(function* (
    input: WorktreeRevivalForThreadInput,
    worktreePath: string,
    outcome: Deferred.Deferred<void, WorktreeMutationError>,
  ) {
    const project = yield* loadProject(input);
    const setupFailed = (cause: unknown) =>
      mutationError("run_setup", cause, {
        path: input.worktreePath,
        workspaceRoot: project.workspaceRoot,
        branch: input.branch,
      });
    const setup = yield* setupScripts
      .runForThread({
        threadId: input.threadId,
        projectId: input.projectId,
        projectCwd: project.workspaceRoot,
        worktreePath,
        project: {
          id: project.id,
          workspaceRoot: project.workspaceRoot,
          scripts: project.scripts,
        },
        // Reports the script's exit code back so a required script can be awaited.
        observeCompletion: {},
      })
      .pipe(Effect.mapError(setupFailed));
    if (setup.status !== "started" || setup.completion === undefined) return;
    if (setup.async) yield* Deferred.succeed(outcome, undefined);
    // Awaiting completion also releases the script's terminal subscription.
    const completion = yield* setup.completion;
    if (!setup.async && completion.exitCode !== 0) {
      return yield* setupFailed(
        `Setup script exited with ${completion.exitCode ?? "no exit code"}.`,
      );
    }
  });

  /**
   * Waits until project setup in a recreated worktree lets the agent start.
   * Concurrent turn starts share one run per worktree generation. The run is
   * forked into the service scope because a cancelled turn start must not
   * stop observing the script, or the next turn would wait on it forever. A
   * failed run is forgotten so the next turn tries setup again.
   */
  const ensureSetup = Effect.fn("WorktreeRevivalService.ensureSetup")(function* (
    input: WorktreeRevivalForThreadInput,
    worktreePath: string,
    generation: number,
  ) {
    const key = setupKey(input.projectId, worktreePath);
    const fresh = yield* Deferred.make<void, WorktreeMutationError>();
    const outcome = yield* Ref.modify(setupRuns, (runs) => {
      const current = runs.get(key);
      if (current !== undefined && current.generation === generation) {
        return [current.outcome, runs] as const;
      }
      return [fresh, new Map(runs).set(key, { generation, outcome: fresh })] as const;
    });
    if (outcome === fresh) {
      yield* runSetup(input, worktreePath, fresh).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (Exit.isFailure(exit)) {
              yield* Ref.update(setupRuns, (runs) => {
                if (runs.get(key)?.outcome !== fresh) return runs;
                const next = new Map(runs);
                next.delete(key);
                return next;
              });
            }
            yield* Deferred.done(fresh, exit);
          }),
        ),
        Effect.forkIn(serviceScope),
      );
    }
    yield* Deferred.await(outcome);
  });

  /**
   * Makes sure a thread's worktree exists before its turn starts. Every turn
   * start on a worktree thread passes through here, so an existing directory
   * is used as is and without the mutation permit: a reaper sweep or a sibling
   * revival must not hold up turns that need no Git mutation. A missing one is
   * recreated from its branch under the permit. Setup for a recreated worktree
   * runs outside the permit, since a slow script must not block every other
   * worktree mutation.
   */
  const reviveForThread: WorktreeRevivalService["Service"]["reviveForThread"] = (input) =>
    Effect.gen(function* () {
      const exists = yield* fs.exists(input.worktreePath).pipe(Effect.orElseSucceed(() => false));
      let revival: {
        readonly revived: boolean;
        readonly generation: number;
        readonly worktreePath: string;
      };
      if (exists) {
        const worktreePath = yield* canonicalizePath(input.worktreePath);
        revival = {
          revived: false,
          generation: yield* currentGeneration(worktreePath),
          worktreePath,
        };
      } else {
        revival = yield* lifecycle.withMutationPermit(
          loadProject(input).pipe(
            Effect.flatMap((project) =>
              reviveWorktreeUnlocked({
                workspaceRoot: project.workspaceRoot,
                worktreePath: input.worktreePath,
                branch: input.branch,
              }),
            ),
          ),
        );
      }
      // Generation 0 means this server never recreated the worktree, so its
      // setup belonged to the thread launch that created it.
      if (revival.generation > 0) {
        yield* ensureSetup(input, revival.worktreePath, revival.generation);
      }
      return { revived: revival.revived, generation: revival.generation };
    });

  return WorktreeRevivalService.of({ reviveWorktree, reviveForThread });
});

export const layer = Layer.effect(WorktreeRevivalService, make);
