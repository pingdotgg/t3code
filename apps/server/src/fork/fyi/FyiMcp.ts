import {
  FYI_TEXT_MAX_CHARS,
  fyiShownState,
  OrchestratorMcpFailure,
  type CommandId,
  type MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadSendResult,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { threadLinkFor, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "../../orchestration-v2/UserFacingErrors.ts";
import { isFyiItem } from "./Fyi.ts";

const isThreadManagementError = Schema.is(ThreadManagementService.ThreadManagementError);

type Runs = OrchestrationV2ThreadProjection["runs"];

export const sendFyi = Effect.fn("FyiMcp.sendFyi")(function* (input: {
  readonly scope: McpInvocationScope;
  readonly send: OrchestratorMcpThreadSendInput;
  readonly thread: Pick<OrchestrationV2AppThread, "projectId" | "title">;
  readonly senderThreadId: ThreadId | undefined;
  readonly ids: Effect.Effect<{ readonly messageId: MessageId; readonly commandId: CommandId }>;
  readonly threadManagement: Pick<ThreadManagementService.ThreadManagementServiceShape, "postFyi">;
  readonly threadManagementFailure: (error: unknown) => OrchestratorMcpFailure;
}) {
  const { scope, send } = input;
  if (send.freshContext === true) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "An FYI starts no turn, so it cannot start a fresh context.",
    });
  }
  if (send.message.length > FYI_TEXT_MAX_CHARS) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `An FYI holds at most ${FYI_TEXT_MAX_CHARS.toLocaleString("en-US")} characters. Send a shorter note, or use mode "queue".`,
    });
  }
  const { messageId, commandId } = yield* input.ids;
  yield* input.threadManagement
    .postFyi({
      projectId: input.thread.projectId,
      commandId,
      threadId: send.threadId,
      ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
      // A linked environment's agent has no thread here; the link names it.
      ...(input.senderThreadId === undefined && scope.client?.senderThread !== undefined
        ? { linkedSender: scope.client.senderThread }
        : {}),
      messageId,
      text: send.message,
      createdBy: "agent",
      creationSource: "mcp",
    })
    .pipe(
      Effect.mapError((error) =>
        isThreadManagementError(error)
          ? input.threadManagementFailure(error)
          : new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: `Unable to send to thread ${send.threadId}: ${userFacingDispatchErrorMessage(error) ?? (error instanceof Error ? error.message : String(error))}`,
            }),
      ),
    );
  return {
    threadId: send.threadId,
    link: threadLinkFor(scope, send.threadId, input.thread.title),
    messageId,
    delivery: "held",
  } satisfies OrchestratorMcpThreadSendResult;
});

/** A fork shows its source's rows, so each FYI's run comes from its row's own thread. */
export const fyiRunsByThread = Effect.fn("FyiMcp.fyiRunsByThread")(function* (
  rows: ReadonlyArray<{
    readonly sourceThreadId: ThreadId;
    readonly item: OrchestrationV2TurnItem;
  }>,
  threadManagement: Pick<ThreadManagementService.ThreadManagementServiceShape, "getThreadRecords">,
  threadManagementFailure: (error: unknown) => OrchestratorMcpFailure,
) {
  const runIdsByThread = new Map<ThreadId, Array<RunId>>();
  for (const row of rows) {
    if (!isFyiItem(row.item) || row.item.runId === null) continue;
    const runIds = runIdsByThread.get(row.sourceThreadId) ?? [];
    runIds.push(row.item.runId);
    runIdsByThread.set(row.sourceThreadId, runIds);
  }
  const runs = yield* Effect.forEach(
    [...runIdsByThread],
    ([threadId, runIds]) =>
      threadManagement.getThreadRecords(threadId, ["runs"], { runIds }).pipe(
        Effect.map((records) => [threadId, records.runs] as const),
        Effect.mapError(threadManagementFailure),
      ),
    { concurrency: 1 },
  );
  return new Map<ThreadId, Runs>(runs);
});

export const fyiTimelineFields = (
  row: { readonly sourceThreadId: ThreadId; readonly item: OrchestrationV2TurnItem },
  runsByThreadId: ReadonlyMap<ThreadId, Runs>,
): { readonly fyi?: ReturnType<typeof fyiShownState> } => {
  const { item } = row;
  if (!isFyiItem(item)) return {};
  return {
    fyi: fyiShownState(
      item,
      runsByThreadId.get(row.sourceThreadId)?.find((run) => run.id === item.runId),
    ),
  };
};
