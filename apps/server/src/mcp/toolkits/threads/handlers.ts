import { CommandId, MessageId, ThreadId, type OrchestrationThreadShell } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { DEFAULT_THREAD_TITLE } from "../../../orchestration/threadTitles.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  StartThreadCallerNotFoundError,
  StartThreadFailedError,
  type StartThreadInput,
  ThreadsToolkit,
} from "./tools.ts";

const encoder = new TextEncoder();

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * The new thread starts with the caller's provider, checkout, and modes. The
 * agent can change the model and the two modes, never the provider or the
 * worktree: those decide what the new thread can touch, and the user set them.
 */
function inheritedThreadSettings(
  parent: OrchestrationThreadShell,
  input: StartThreadInput,
): Pick<
  OrchestrationThreadShell,
  "projectId" | "modelSelection" | "runtimeMode" | "interactionMode" | "branch" | "worktreePath"
> {
  return {
    projectId: parent.projectId,
    modelSelection:
      input.model === undefined
        ? parent.modelSelection
        : { instanceId: parent.modelSelection.instanceId, model: input.model },
    runtimeMode: input.runtimeMode ?? parent.runtimeMode,
    interactionMode: input.interactionMode ?? parent.interactionMode,
    branch: parent.branch,
    worktreePath: parent.worktreePath,
  };
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  const failed = <E>(cause: Cause.Cause<E>): Effect.Effect<never, StartThreadFailedError> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(new StartThreadFailedError({ cause }));

  // With a clientRequestId, the thread id and both command ids are a function
  // of the caller and the request. The engine replays an accepted command id
  // instead of running it again, so a retry after a dropped response, or two
  // overlapping calls, land on one thread with one first turn. A thread id
  // made this way is never created twice, so a deleted one cannot come back
  // under a pending cleanup. Without a clientRequestId every call is new.
  const requestIds = (scope: McpInvocationContext.McpInvocationScope, input: StartThreadInput) =>
    input.clientRequestId === undefined
      ? Effect.gen(function* () {
          const threadId = ThreadId.make(yield* uuid);
          return {
            threadId,
            createCommandId: CommandId.make(`server:mcp-thread-create:${threadId}:${yield* uuid}`),
            turnCommandId: CommandId.make(
              `server:mcp-thread-turn-start:${threadId}:${yield* uuid}`,
            ),
          };
        })
      : crypto.digest("SHA-256", encoder.encode(`${scope.threadId} ${input.clientRequestId}`)).pipe(
          Effect.orDie,
          Effect.map((digest) => {
            const threadId = ThreadId.make(`mcp-${hex(digest).slice(0, 32)}`);
            return {
              threadId,
              createCommandId: CommandId.make(`server:mcp-thread-create:${threadId}`),
              turnCommandId: CommandId.make(`server:mcp-thread-turn-start:${threadId}`),
            };
          }),
        );

  return ThreadsToolkit.of({
    start_thread: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("threads");
        const parent = yield* snapshots
          .getThreadShellById(scope.threadId)
          .pipe(Effect.catchCause(failed));
        if (Option.isNone(parent)) {
          return yield* new StartThreadCallerNotFoundError({ threadId: scope.threadId });
        }

        const { threadId, createCommandId, turnCommandId } = yield* requestIds(scope, input);
        const title = input.title ?? DEFAULT_THREAD_TITLE;
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* engine
          .dispatch({
            type: "thread.create",
            commandId: createCommandId,
            threadId,
            title,
            createdAt,
            ...inheritedThreadSettings(parent.value, input),
          })
          .pipe(Effect.catchCause(failed));
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: turnCommandId,
            threadId,
            message: {
              messageId: MessageId.make(`mcp-start:${threadId}`),
              role: "user",
              text: input.prompt,
              attachments: [],
            },
            // The reactor generates a title from the first turn unless the
            // agent named the thread. Seeding with the given title keeps it.
            ...(input.title !== undefined ? { titleSeed: input.title } : {}),
            runtimeMode: input.runtimeMode ?? parent.value.runtimeMode,
            interactionMode: input.interactionMode ?? parent.value.interactionMode,
            createdAt,
          })
          .pipe(Effect.catchCause(failed));
        return { threadId, title };
      }),
  });
});

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(make);
