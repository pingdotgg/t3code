import {
  CHAT_PROJECT_TITLE,
  CommandId,
  ProjectId,
  type ThreadId,
  type ThreadTurnStartBootstrap,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export class ChatScratchDirectoryError extends Schema.TaggedErrorClass<ChatScratchDirectoryError>()(
  "ChatScratchDirectoryError",
  {
    directory: Schema.String,
    stage: Schema.Literals(["project-root", "thread-worktree"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to create chat scratch directory '${this.directory}'.`;
  }
}

export class ChatProjectLookupError extends Schema.TaggedErrorClass<ChatProjectLookupError>()(
  "ChatProjectLookupError",
  {
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return `Chat project '${this.projectId}' was created but could not be read back.`;
  }
}

export class ChatScratchThreadPathError extends Schema.TaggedErrorClass<ChatScratchThreadPathError>()(
  "ChatScratchThreadPathError",
  {
    threadId: Schema.String,
    workspaceRoot: Schema.String,
    worktreePath: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Chat scratch thread path for '${this.threadId}' is not a single directory under '${this.workspaceRoot}'.`;
  }
}

export type GetOrCreateChatProjectError =
  | OrchestrationDispatchError
  | ChatScratchDirectoryError
  | ChatProjectLookupError;

export type PrepareChatScratchError = GetOrCreateChatProjectError | ChatScratchThreadPathError;

export const chatScratchWorkspaceRoot = Effect.fn("chatScratchWorkspaceRoot")(function* () {
  const serverConfig = yield* ServerConfig;
  const path = yield* Path.Path;
  return path.join(serverConfig.baseDir, "scratch", "chats");
});

const findActiveChatProject = Effect.fn("findActiveChatProject")(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const readModel = yield* snapshotQuery.getCommandReadModel();
  return Option.fromNullishOr(
    readModel.projects.find((project) => project.deletedAt === null && project.kind === "chat") ??
      null,
  );
});

const ensureDirectory = Effect.fn("ensureChatScratchDirectory")(function* (
  directory: string,
  stage: ChatScratchDirectoryError["stage"],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new ChatScratchDirectoryError({
          directory,
          stage,
          cause,
        }),
    ),
  );
});

export const getOrCreateChatProject = Effect.fn("getOrCreateChatProject")(function* () {
  const existing = yield* findActiveChatProject();
  if (Option.isSome(existing)) {
    yield* ensureDirectory(existing.value.workspaceRoot, "project-root");
    return existing.value;
  }

  const workspaceRoot = yield* chatScratchWorkspaceRoot();
  yield* ensureDirectory(workspaceRoot, "project-root");

  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const projectId = ProjectId.make(yield* crypto.randomUUIDv4);
  yield* orchestrationEngine
    .dispatch({
      type: "project.create",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      projectId,
      title: CHAT_PROJECT_TITLE,
      workspaceRoot,
      createWorkspaceRootIfMissing: true,
      kind: "chat",
      createdAt,
    })
    .pipe(
      Effect.catchTags({
        OrchestrationCommandInvariantError: (error) =>
          findActiveChatProject().pipe(
            Effect.flatMap((recovered) =>
              Option.isSome(recovered) ? Effect.void : Effect.fail(error),
            ),
          ),
      }),
    );

  const createdProject = yield* findActiveChatProject();
  if (Option.isNone(createdProject)) {
    return yield* new ChatProjectLookupError({
      projectId,
    });
  }
  return createdProject.value;
});

export const prepareChatScratchCreateThread = Effect.fn("prepareChatScratchCreateThread")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly createThread: NonNullable<ThreadTurnStartBootstrap["createThread"]>;
  }) {
    if (input.createThread.createInChatScratch !== true) {
      return {
        createThread: input.createThread,
        skipPrepareWorktree: false,
      };
    }

    const chatProject = yield* getOrCreateChatProject();
    const path = yield* Path.Path;
    if (
      path.basename(input.threadId) !== input.threadId ||
      input.threadId === "." ||
      input.threadId === ".."
    ) {
      return yield* new ChatScratchThreadPathError({
        threadId: input.threadId,
        workspaceRoot: chatProject.workspaceRoot,
      });
    }
    const workspaceRoot = path.resolve(chatProject.workspaceRoot);
    const worktreePath = path.resolve(workspaceRoot, input.threadId);
    const relative = path.relative(workspaceRoot, worktreePath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return yield* new ChatScratchThreadPathError({
        threadId: input.threadId,
        workspaceRoot,
        worktreePath,
      });
    }
    yield* ensureDirectory(worktreePath, "thread-worktree");

    return {
      createThread: {
        ...input.createThread,
        projectId: chatProject.id,
        worktreePath,
        branch: null,
      },
      skipPrepareWorktree: true,
    };
  },
);
