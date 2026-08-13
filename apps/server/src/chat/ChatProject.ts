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

import { ServerConfig } from "../config.ts";
import {
  OrchestrationCommandInvariantError,
  type OrchestrationDispatchError,
} from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export type GetOrCreateChatProjectError = OrchestrationDispatchError | ProjectionRepositoryError;

const isWorkspaceRootTaken = (error: OrchestrationDispatchError): boolean =>
  error._tag === "OrchestrationCommandInvariantError" &&
  error.detail.includes("already exists for workspace root");

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

const ensureDirectory = Effect.fn("ensureChatScratchDirectory")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationCommandInvariantError({
          commandType: "project.create",
          detail: `Failed to create chat scratch directory '${directory}'.`,
          cause,
        }),
    ),
  );
});

export const getOrCreateChatProject = Effect.fn("getOrCreateChatProject")(function* () {
  const existing = yield* findActiveChatProject();
  if (Option.isSome(existing)) {
    yield* ensureDirectory(existing.value.workspaceRoot);
    return existing.value;
  }

  const workspaceRoot = yield* chatScratchWorkspaceRoot();
  yield* ensureDirectory(workspaceRoot);

  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const projectId = ProjectId.make(yield* crypto.randomUUIDv4);
  const created = yield* orchestrationEngine
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
      Effect.matchEffect({
        onFailure: (error) =>
          isWorkspaceRootTaken(error)
            ? findActiveChatProject().pipe(
                Effect.flatMap((recovered) =>
                  Option.isSome(recovered) ? Effect.succeed(recovered.value) : Effect.fail(error),
                ),
              )
            : Effect.fail(error),
        onSuccess: () =>
          findActiveChatProject().pipe(
            Effect.flatMap((createdProject) =>
              Option.isSome(createdProject)
                ? Effect.succeed(createdProject.value)
                : Effect.fail(
                    new OrchestrationCommandInvariantError({
                      commandType: "project.create",
                      detail: "Chat project was created but could not be read back.",
                    }),
                  ),
            ),
          ),
      }),
    );

  return created;
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
    const worktreePath = path.join(chatProject.workspaceRoot, input.threadId);
    yield* ensureDirectory(worktreePath);

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
