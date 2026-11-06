import {
  CommandId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { threadHasUnfinishedWork } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";

export class ScratchThreadPromotionError extends Schema.TaggedError<ScratchThreadPromotionError>()(
  "ScratchThreadPromotionError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class ScratchThreadPromotion extends Context.Service<
  ScratchThreadPromotion,
  {
    /**
     * Turns a No project thread's folder into a project, in place, and moves every
     * thread working in that folder into it. Running it again finishes a partial move.
     */
    readonly promote: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<{ readonly projectId: ProjectId }, ScratchThreadPromotionError>;
    /**
     * Files a No project thread under an existing project. The thread keeps its own
     * folder as its working folder, so its provider session resumes unchanged.
     */
    readonly moveInto: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
    }) => Effect.Effect<{ readonly projectId: ProjectId }, ScratchThreadPromotionError>;
  }
>()("t3/project/ScratchThreadPromotion") {}

const make = Effect.gen(function* () {
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const random = yield* SecureRandom.SecureRandom;
  const path = yield* Path.Path;

  const fail = (reason: string) => (cause: unknown) =>
    new ScratchThreadPromotionError({ reason, cause });

  const promote: ScratchThreadPromotion["Service"]["promote"] = Effect.fn(
    "ScratchThreadPromotion.promote",
  )(function* (input) {
    const thread = yield* threads.getThreadShell(input.threadId).pipe(
      Effect.mapError(fail("Could not read the thread.")),
      Effect.filterOrFail(
        (shell) => shell !== null,
        () => new ScratchThreadPromotionError({ reason: "Thread not found." }),
      ),
    );
    const project = yield* projects
      .getById(thread.projectId)
      .pipe(Effect.mapError(fail("Could not read the thread's project.")));
    const folder = thread.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot;
    const scratchRoot = Option.getOrUndefined(yield* managedFolders.scratchRoot);
    const isScratch = yield* managedFolders.isScratchProject(thread.projectId);
    // A thread already rooted at its folder is a partial earlier promotion; finish it.
    const alreadyPromoted =
      Option.isSome(project) && project.value.workspaceRoot === folder && !isScratch;
    if (
      folder === undefined ||
      scratchRoot === undefined ||
      path.dirname(folder) !== scratchRoot ||
      !(isScratch || alreadyPromoted)
    ) {
      return yield* new ScratchThreadPromotionError({
        reason: "Only a No project thread with its own folder can become a project.",
      });
    }

    const snapshot = yield* Effect.flatten(
      threads.readShellSnapshot({ worktreePath: folder }),
    ).pipe(Effect.mapError(fail("Could not read the threads in this folder.")));
    const moveSet = new Map<ThreadId, OrchestrationV2ThreadShell>();
    if (isScratch) moveSet.set(thread.id, thread);
    for (const candidate of [...snapshot.threads, ...snapshot.archivedThreads]) {
      if (yield* managedFolders.isScratchProject(candidate.projectId)) {
        moveSet.set(candidate.id, candidate);
      }
    }

    for (const candidate of moveSet.values()) {
      const records = yield* threads
        .getThreadRecords(candidate.id, ["runs", "runtimeRequests"], { turnItemTypes: [] })
        .pipe(Effect.mapError(fail(`Could not read "${candidate.title}".`)));
      if (threadHasUnfinishedWork(records)) {
        return yield* new ScratchThreadPromotionError({
          reason: `"${candidate.title}" is still working. Finish or stop it first.`,
        });
      }
    }

    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const projectId = yield* createProject(thread.title, folder);
        yield* scheduledTasks
          .moveThreadTasks({ threadIds: [...moveSet.keys()], projectId })
          .pipe(Effect.mapError(fail("Could not move the thread's scheduled tasks.")));
        for (const candidate of moveSet.values()) {
          const commandId = CommandId.make(`scratch-promotion:${yield* randomId}`);
          yield* threads
            .dispatch({
              type: "thread.project.adopt-folder",
              commandId,
              threadId: candidate.id,
              projectId,
            })
            .pipe(Effect.mapError(fail(`Could not move "${candidate.title}". Try again.`)));
        }
        return { projectId };
      }),
    );
  });

  const moveInto: ScratchThreadPromotion["Service"]["moveInto"] = Effect.fn(
    "ScratchThreadPromotion.moveInto",
  )(function* (input) {
    const thread = yield* threads.getThreadShell(input.threadId).pipe(
      Effect.mapError(fail("Could not read the thread.")),
      Effect.filterOrFail(
        (shell) => shell !== null,
        () => new ScratchThreadPromotionError({ reason: "Thread not found." }),
      ),
    );
    if (!thread.worktreePath || !(yield* managedFolders.isScratchProject(thread.projectId))) {
      return yield* new ScratchThreadPromotionError({
        reason: "Only a No project thread with its own folder can move to a project.",
      });
    }
    if (yield* managedFolders.isScratchProject(input.projectId)) {
      return yield* new ScratchThreadPromotionError({ reason: "Pick a project to move it to." });
    }
    const target = yield* projects
      .getById(input.projectId)
      .pipe(Effect.mapError(fail("Could not read the project.")));
    if (Option.isNone(target)) {
      return yield* new ScratchThreadPromotionError({ reason: "That project no longer exists." });
    }
    const records = yield* threads
      .getThreadRecords(thread.id, ["runs", "runtimeRequests"], { turnItemTypes: [] })
      .pipe(Effect.mapError(fail(`Could not read "${thread.title}".`)));
    if (threadHasUnfinishedWork(records)) {
      return yield* new ScratchThreadPromotionError({
        reason: `"${thread.title}" is still working. Finish or stop it first.`,
      });
    }
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* scheduledTasks
          .moveThreadTasks({ threadIds: [thread.id], projectId: input.projectId })
          .pipe(Effect.mapError(fail("Could not move the thread's scheduled tasks.")));
        const commandId = CommandId.make(`scratch-move:${yield* randomId}`);
        yield* threads
          .dispatch({
            type: "thread.project.adopt-folder",
            commandId,
            threadId: thread.id,
            projectId: input.projectId,
            keepFolder: true,
          })
          .pipe(Effect.mapError(fail(`Could not move "${thread.title}". Try again.`)));
        return { projectId: input.projectId };
      }),
    );
  });

  const randomId = random.uuidV4();

  // bootstrap returns the project that already owns the folder, so retries reuse it.
  const createProject = Effect.fn("ScratchThreadPromotion.createProject")(function* (
    title: string,
    workspaceRoot: string,
  ) {
    const id = yield* randomId;
    return yield* projects
      .bootstrap({
        commandId: CommandId.make(`scratch-promotion-project:${id}`),
        projectId: ProjectId.make(id),
        title,
        workspaceRoot,
      })
      .pipe(
        Effect.map(({ project }) => project.id),
        // bootstrap reads before locking; racing creates return the winner in a conflict.
        Effect.catchTags({
          ProjectConflictError: (conflict) => Effect.succeed(conflict.conflictingProjectId),
        }),
        Effect.mapError(fail("Could not create the project.")),
      );
  });

  return ScratchThreadPromotion.of({ promote, moveInto });
});

export const layer = Layer.effect(ScratchThreadPromotion, make);
