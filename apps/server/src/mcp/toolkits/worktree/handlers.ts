import {
  CommandId,
  VcsProcessExitError,
  type ThreadId,
  type VcsRepositoryIdentity,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VcsDriverRegistry from "../../../vcs/VcsDriverRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  WorktreeHandoffFailedError,
  WorktreeHandoffPathInvalidError,
  WorktreeHandoffThreadNotFoundError,
  WorktreeToolkit,
} from "./tools.ts";

const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const crypto = yield* Crypto.Crypto;

  const commandId = (threadId: ThreadId) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:mcp-worktree-handoff:${threadId}:${uuid}`)),
    );

  // Symlinked or 8.3 short paths must compare equal to their long form.
  const canonical = (target: string) =>
    fileSystem.realPath(target).pipe(
      Effect.orElseSucceed(() => target),
      Effect.map((resolved) => path.normalize(resolved)),
    );

  // Git reports the common dir relative to the root for a main checkout and
  // absolute for a linked worktree.
  const commonDirOf = (repository: VcsRepositoryIdentity) =>
    repository.metadataPath === null
      ? Effect.succeed(null)
      : canonical(path.resolve(repository.rootPath, repository.metadataPath));

  const detectGit = (cwd: string, detail: string) =>
    vcsRegistry.detect({ cwd, requestedKind: "git" }).pipe(
      Effect.catch(() => Effect.succeed(null)),
      Effect.flatMap((handle) =>
        handle === null ? new WorktreeHandoffPathInvalidError({ detail }) : Effect.succeed(handle),
      ),
    );

  return WorktreeToolkit.of({
    t3_worktree_handoff: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("worktree");
        const thread = yield* snapshots
          .getThreadShellById(scope.threadId)
          .pipe(Effect.mapError((cause) => new WorktreeHandoffFailedError({ cause })));
        if (Option.isNone(thread)) {
          return yield* new WorktreeHandoffThreadNotFoundError({ threadId: scope.threadId });
        }
        const project = yield* snapshots
          .getProjectShellById(thread.value.projectId)
          .pipe(Effect.mapError((cause) => new WorktreeHandoffFailedError({ cause })));
        if (Option.isNone(project)) {
          return yield* new WorktreeHandoffThreadNotFoundError({ threadId: scope.threadId });
        }
        if (!path.isAbsolute(input.path)) {
          return yield* new WorktreeHandoffPathInvalidError({
            detail: "Pass the worktree's absolute path.",
          });
        }

        const target = yield* detectGit(
          input.path,
          `${input.path} does not exist or is not inside a git worktree.`,
        );
        const home = yield* detectGit(
          project.value.workspaceRoot,
          "This thread's project is not a git repository.",
        );
        // Persist git's own spelling of the root, which is what session cwds and
        // status lookups report; canonical forms are only for the checks below.
        const worktreePath = path.normalize(target.repository.rootPath);
        const canonicalRoot = yield* canonical(worktreePath);
        if (canonicalRoot === (yield* canonical(home.repository.rootPath))) {
          return yield* new WorktreeHandoffPathInvalidError({
            detail:
              "That is the project's own checkout, which this thread uses when it has no worktree.",
          });
        }
        const targetCommonDir = yield* commonDirOf(target.repository);
        if (targetCommonDir === null || targetCommonDir !== (yield* commonDirOf(home.repository))) {
          return yield* new WorktreeHandoffPathInvalidError({
            detail: `${input.path} is not a worktree of this thread's project repository.`,
          });
        }

        // With --quiet a detached HEAD exits 1 and any other failure exits 128.
        // A detached HEAD has no branch; the thread then shows the worktree without one.
        const operation = "WorktreeToolkit.headBranch";
        const head = yield* target.driver
          .execute({
            operation,
            cwd: worktreePath,
            args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
            allowNonZeroExit: true,
          })
          .pipe(Effect.mapError((cause) => new WorktreeHandoffFailedError({ cause })));
        if (head.exitCode !== 0 && head.exitCode !== 1) {
          return yield* new WorktreeHandoffFailedError({
            cause: new VcsProcessExitError({
              operation,
              command: "git symbolic-ref",
              cwd: worktreePath,
              exitCode: head.exitCode,
              detail: head.stderr.trim() || "Could not read the worktree's HEAD.",
            }),
          });
        }
        const branch = head.exitCode === 0 ? head.stdout.trim() || null : null;

        yield* engine
          .dispatch({
            type: "thread.meta.update",
            commandId: yield* commandId(thread.value.id),
            threadId: thread.value.id,
            worktreePath,
            branch,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause as Cause.Cause<never>)
                : Effect.fail(new WorktreeHandoffFailedError({ cause })),
            ),
          );

        return { worktreePath, branch, previousWorktreePath: thread.value.worktreePath };
      }),
  });
});

export const WorktreeToolkitHandlersLive = WorktreeToolkit.toLayer(make);
