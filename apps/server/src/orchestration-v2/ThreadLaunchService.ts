import {
  CommandId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2ThreadProjection,
  type ProviderInteractionMode,
  ProjectId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export type ThreadLaunchWorkspaceStrategy =
  | { readonly type: "root" }
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: string;
    };

export interface ThreadLaunchInitialMessage {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

export interface ThreadLaunchInput {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceStrategy: ThreadLaunchWorkspaceStrategy;
  readonly initialMessage?: ThreadLaunchInitialMessage;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export interface ThreadLaunchResult {
  readonly threadId: ThreadId;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly resumed: boolean;
}

export class ThreadLaunchError extends Schema.TaggedErrorClass<ThreadLaunchError>()(
  "ThreadLaunchError",
  {
    operation: Schema.Literals([
      "resolve-project",
      "load-workflow",
      "persist-workflow",
      "generate-metadata",
      "provision-worktree",
      "run-setup-script",
      "create-thread",
      "dispatch-message",
      "compensate-worktree",
    ]),
    commandId: CommandId,
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread launch ${this.commandId} failed during ${this.operation}.`;
  }
}

type WorkflowRow = {
  readonly command_id: string;
  readonly thread_id: string;
  readonly project_id: string;
  readonly status: string;
  readonly title: string;
  readonly worktree_path: string | null;
  readonly branch: string | null;
  readonly setup_committed: number;
  readonly thread_committed: number;
  readonly message_committed: number;
};

export class ThreadLaunchService extends Context.Service<
  ThreadLaunchService,
  {
    readonly launch: (
      input: ThreadLaunchInput,
    ) => Effect.Effect<ThreadLaunchResult, ThreadLaunchError>;
  }
>()("t3/orchestration-v2/ThreadLaunchService") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitWorkflow.GitWorkflowService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launchSemaphore = yield* Semaphore.make(1);

  const mapError =
    (input: ThreadLaunchInput, operation: ThreadLaunchError["operation"], threadId?: ThreadId) =>
    (cause: unknown) =>
      new ThreadLaunchError({
        operation,
        commandId: input.commandId,
        projectId: input.projectId,
        ...(threadId === undefined ? {} : { threadId }),
        cause,
      });

  const loadWorkflow = Effect.fn("ThreadLaunchService.loadWorkflow")(function* (
    input: ThreadLaunchInput,
  ) {
    const rows = yield* sql<WorkflowRow>`
      SELECT * FROM orchestration_v2_thread_launch_workflows
      WHERE command_id = ${input.commandId}
    `.pipe(Effect.mapError(mapError(input, "load-workflow")));
    return rows[0] ?? null;
  });

  const saveWorkflow = Effect.fn("ThreadLaunchService.saveWorkflow")(function* (
    input: ThreadLaunchInput,
    row: {
      readonly threadId: ThreadId;
      readonly status: string;
      readonly title: string;
      readonly worktreePath: string | null;
      readonly branch: string | null;
      readonly setupCommitted: boolean;
      readonly threadCommitted: boolean;
      readonly messageCommitted: boolean;
      readonly lastError?: string | null;
    },
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO orchestration_v2_thread_launch_workflows (
        command_id, thread_id, project_id, status, title, worktree_path, branch, setup_committed,
        thread_committed, message_committed, last_error, created_at, updated_at
      ) VALUES (
        ${input.commandId}, ${row.threadId}, ${input.projectId}, ${row.status}, ${row.title},
        ${row.worktreePath}, ${row.branch}, ${row.setupCommitted ? 1 : 0}, ${row.threadCommitted ? 1 : 0},
        ${row.messageCommitted ? 1 : 0}, ${row.lastError ?? null}, ${now}, ${now}
      ) ON CONFLICT(command_id) DO UPDATE SET
        status = excluded.status,
        title = excluded.title,
        worktree_path = excluded.worktree_path,
        branch = excluded.branch,
        setup_committed = excluded.setup_committed,
        thread_committed = excluded.thread_committed,
        message_committed = excluded.message_committed,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(mapError(input, "persist-workflow", row.threadId)));
  });

  const launchWorkflow: ThreadLaunchService["Service"]["launch"] = Effect.fn(
    "ThreadLaunchService.launch",
  )(function* (input) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError(mapError(input, "resolve-project")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(mapError(input, "resolve-project")("Project not found.")),
          onSome: Effect.succeed,
        }),
      ),
    );
    const stored = yield* loadWorkflow(input);
    const threadId =
      stored === null
        ? yield* ids.allocate
            .thread({ projectId: input.projectId })
            .pipe(Effect.mapError(mapError(input, "persist-workflow")))
        : ThreadId.make(stored.thread_id);
    if (stored?.status === "completed") {
      return {
        threadId,
        projection: yield* threads
          .getThreadProjection(threadId)
          .pipe(Effect.mapError(mapError(input, "create-thread", threadId))),
        resumed: true,
      };
    }

    let branch = stored?.branch ?? null;
    let title = stored?.title ?? input.title;
    if (input.initialMessage !== undefined) {
      if (title === "New thread") {
        title = yield* textGeneration
          .generateThreadTitle({
            cwd: project.workspaceRoot,
            message: input.initialMessage.text,
            attachments: input.initialMessage.attachments,
            modelSelection: input.modelSelection,
          })
          .pipe(
            Effect.map((result) => result.title),
            Effect.mapError(mapError(input, "generate-metadata", threadId)),
          );
      }
      if (input.workspaceStrategy.type === "worktree" && branch === null) {
        branch = yield* textGeneration
          .generateBranchName({
            cwd: project.workspaceRoot,
            message: input.initialMessage.text,
            attachments: input.initialMessage.attachments,
            modelSelection: input.modelSelection,
          })
          .pipe(
            Effect.map((result) => result.branch),
            Effect.mapError(mapError(input, "generate-metadata", threadId)),
          );
      }
    }
    if (input.workspaceStrategy.type === "worktree") {
      branch = branch ?? input.workspaceStrategy.branch ?? `thread-${threadId}`;
    }

    let worktreePath = stored?.worktree_path ?? null;
    const threadCommitted = stored?.thread_committed === 1;
    let setupCommitted = stored?.setup_committed === 1;
    let messageCommitted = stored?.message_committed === 1;
    if (input.workspaceStrategy.type === "worktree" && worktreePath === null) {
      const worktree = yield* git
        .createWorktree({
          cwd: project.workspaceRoot,
          refName: input.workspaceStrategy.baseRef,
          newRefName: branch!,
          baseRefName: input.workspaceStrategy.baseRef,
          path: null,
        })
        .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
      worktreePath = worktree.worktree.path;
      branch = worktree.worktree.refName;
      yield* saveWorkflow(input, {
        threadId,
        status: "workspace_ready",
        title,
        worktreePath,
        branch,
        setupCommitted,
        threadCommitted,
        messageCommitted,
      });
    }
    const cwd = worktreePath ?? project.workspaceRoot;

    if (!setupCommitted) {
      const setupExit = yield* Effect.exit(
        setupScripts.runForThread({
          threadId,
          projectId: input.projectId,
          projectCwd: project.workspaceRoot,
          worktreePath: cwd,
          project: {
            workspaceRoot: project.workspaceRoot,
            scripts: project.scripts,
          },
        }),
      );
      if (setupExit._tag === "Failure") {
        if (worktreePath !== null && !threadCommitted) {
          yield* git
            .removeWorktree({ cwd: project.workspaceRoot, path: worktreePath })
            .pipe(Effect.mapError(mapError(input, "compensate-worktree", threadId)));
          worktreePath = null;
        }
        yield* saveWorkflow(input, {
          threadId,
          status: "setup_failed",
          title,
          worktreePath,
          branch,
          setupCommitted: false,
          threadCommitted,
          messageCommitted,
          lastError: "Project setup script failed.",
        });
        return yield* Effect.failCause(setupExit.cause).pipe(
          Effect.mapError(mapError(input, "run-setup-script", threadId)),
        );
      }
      setupCommitted = true;
      yield* saveWorkflow(input, {
        threadId,
        status: "setup_ready",
        title,
        worktreePath,
        branch,
        setupCommitted,
        threadCommitted,
        messageCommitted,
      });
    }

    if (!threadCommitted) {
      const createExit = yield* Effect.exit(
        threads.dispatch({
          type: "thread.create",
          commandId: input.commandId,
          threadId,
          projectId: input.projectId,
          title,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          branch,
          worktreePath,
          createdBy: input.createdBy,
          creationSource: input.creationSource,
        }),
      );
      if (createExit._tag === "Failure") {
        if (worktreePath !== null) {
          yield* git
            .removeWorktree({ cwd: project.workspaceRoot, path: worktreePath })
            .pipe(Effect.mapError(mapError(input, "compensate-worktree", threadId)));
          worktreePath = null;
          setupCommitted = false;
        }
        yield* saveWorkflow(input, {
          threadId,
          status: "thread_create_failed",
          title,
          worktreePath,
          branch,
          setupCommitted,
          threadCommitted: false,
          messageCommitted,
          lastError: "Thread creation failed.",
        });
        return yield* Effect.failCause(createExit.cause).pipe(
          Effect.mapError(mapError(input, "create-thread", threadId)),
        );
      }
      yield* saveWorkflow(input, {
        threadId,
        status: "thread_created",
        title,
        worktreePath,
        branch,
        setupCommitted,
        threadCommitted: true,
        messageCommitted,
      });
    }

    if (input.initialMessage !== undefined && !messageCommitted) {
      const messageId = yield* ids.allocate
        .message({ threadId, ordinal: 1 })
        .pipe(Effect.mapError(mapError(input, "dispatch-message", threadId)));
      yield* threads
        .sendToThread({
          projectId: input.projectId,
          commandId: CommandId.make(`${input.commandId}:initial-message`),
          threadId,
          messageId,
          text: input.initialMessage.text,
          attachments: input.initialMessage.attachments,
          mode: "auto",
          createdBy: input.createdBy,
          creationSource: input.creationSource,
        })
        .pipe(Effect.mapError(mapError(input, "dispatch-message", threadId)));
      messageCommitted = true;
    }
    yield* saveWorkflow(input, {
      threadId,
      status: "completed",
      title,
      worktreePath,
      branch,
      setupCommitted,
      threadCommitted: true,
      messageCommitted,
    });
    return {
      threadId,
      projection: yield* threads
        .getThreadProjection(threadId)
        .pipe(Effect.mapError(mapError(input, "create-thread", threadId))),
      resumed: stored !== null,
    };
  });

  return ThreadLaunchService.of({
    launch: (input) => launchSemaphore.withPermit(launchWorkflow(input)),
  });
});

export const layer = Layer.effect(ThreadLaunchService, make);
