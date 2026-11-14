import { CommandId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import { threadMoveNotice } from "@t3tools/shared/threadMove";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";

export class ThreadProjectMoveError extends Schema.TaggedError<ThreadProjectMoveError>()(
  "ThreadProjectMoveError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class ThreadProjectMove extends Context.Service<
  ThreadProjectMove,
  {
    /**
     * Moves an idle thread, with its scheduled tasks, into another project's root folder.
     * Running it again finishes a partial move.
     */
    readonly move: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
    }) => Effect.Effect<{ readonly notice: string }, ThreadProjectMoveError>;
  }
>()("t3/project/ThreadProjectMove") {}

const make = Effect.gen(function* () {
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const git = yield* GitWorkflowService.GitWorkflowService;
  const randomId = (yield* SecureRandom.SecureRandom).uuidV4();

  const fail = (reason: string) => (cause: unknown) =>
    new ThreadProjectMoveError({ reason, cause });

  const move: ThreadProjectMove["Service"]["move"] = Effect.fn("ThreadProjectMove.move")(
    function* (input) {
      const target = yield* projects
        .getById(input.projectId)
        .pipe(Effect.mapError(fail("Could not read the project.")));
      if (Option.isNone(target) || target.value.deletedAt !== null) {
        return yield* new ThreadProjectMoveError({ reason: "Project not found." });
      }
      // No project holds one folder per thread, so its root is no place to work.
      if (yield* managedFolders.isScratchProject(input.projectId)) {
        return yield* new ThreadProjectMoveError({
          reason: "A thread cannot move into No project.",
        });
      }
      const thread = yield* threads.getThreadShell(input.threadId).pipe(
        Effect.mapError(fail("Could not read the thread.")),
        Effect.filterOrFail(
          (shell) => shell !== null,
          () => new ThreadProjectMoveError({ reason: "Thread not found." }),
        ),
      );
      if (thread.projectId !== input.projectId) {
        const branch = yield* git
          .currentBranch(target.value.workspaceRoot)
          .pipe(Effect.orElseSucceed(() => null));
        yield* threads
          .dispatch({
            type: "thread.project.move",
            commandId: CommandId.make(`thread-project-move:${yield* randomId}`),
            threadId: input.threadId,
            projectId: input.projectId,
            branch,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ThreadProjectMoveError({
                  reason: userFacingDispatchErrorMessage(cause) ?? "Could not move the thread.",
                  cause,
                }),
            ),
          );
      }
      // Another move can commit before these writes, so follow the thread until a read matches.
      const currentProject = threads.getThreadShell(input.threadId).pipe(
        Effect.map((shell) => shell?.projectId ?? input.projectId),
        Effect.mapError(fail("Could not read the thread.")),
      );
      let projectId = yield* currentProject;
      while (true) {
        yield* scheduledTasks
          .moveThreadTasks({ threadIds: [input.threadId], projectId })
          .pipe(Effect.mapError(fail("Moved the thread, but not its scheduled tasks. Try again.")));
        const now = yield* currentProject;
        if (now === projectId) break;
        projectId = now;
      }
      return {
        notice: threadMoveNotice({
          projectTitle: target.value.title,
          fromWorktree: thread.worktreePath !== null,
        }),
      };
    },
  );

  return ThreadProjectMove.of({ move });
});

export const layer = Layer.effect(ThreadProjectMove, make);
