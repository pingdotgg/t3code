import type { OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";

import {
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as Effect from "effect/Effect";

import { visibleConversationItems } from "./ContextHandoffService.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

const ATTACHMENT_ITEM_TYPES = ["user_message", "user_input_request"] as const;

function attachmentIds(items: ReadonlyArray<OrchestrationV2TurnItem>) {
  return items.flatMap((item) => {
    if (item.type === "user_message") return item.attachments.map((attachment) => attachment.id);
    if (item.type !== "user_input_request") return [];
    return Object.values(item.questionAnswer?.attachmentsByQuestionId ?? {}).flatMap((files) =>
      files.map((attachment) => attachment.id),
    );
  });
}

/**
 * Uploads a thread's agent may read: those in the history the agent was given. That is the
 * thread's visible rows plus each run-fork ancestor's visible rows through its fork run, the same
 * cutoff as `readInheritedHandoffItems`. Side chats inherit no rows, so they inherit no uploads.
 */
export const readThreadReadableAttachmentIds = Effect.fn(
  "ThreadReadableAttachments.readThreadReadableAttachmentIds",
)(function* (
  projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  threadId: ThreadId,
) {
  const own = yield* projectionStore.getThreadRecords(threadId, ["runs", "attempts", "turnItems"], {
    turnItemTypes: ATTACHMENT_ITEM_TYPES,
  });
  const ids = new Set(attachmentIds(visibleConversationItems(own, own.turnItems)));
  const seen = new Set([threadId]);
  let current = own.thread;
  while (
    current.forkedFrom?.type === "run" &&
    current.lineage.sideChat !== true &&
    !seen.has(current.forkedFrom.threadId)
  ) {
    const { threadId: sourceId, runId } = current.forkedFrom;
    seen.add(sourceId);
    const source = yield* projectionStore
      .getThreadRecords(sourceId, ["runs", "attempts"])
      .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));
    const forkRun = source?.runs.find((run) => run.id === runId);
    if (source === null || forkRun === undefined) break;
    const { turnItems } = yield* projectionStore.getThreadRecords(sourceId, ["turnItems"], {
      turnItemTypes: ATTACHMENT_ITEM_TYPES,
      turnItemRunIds: [
        ...source.runs.filter((run) => run.ordinal <= forkRun.ordinal).map((run) => run.id),
        ...(source.thread.historyOrigin === "v1_import" ? [null] : []),
      ],
    });
    for (const id of attachmentIds(visibleConversationItems(source, turnItems))) ids.add(id);
    current = source.thread;
  }
  // A client can name another thread's stored upload; only uploads owned by this lineage count.
  const owners = new Set([...seen].map(toSafeThreadAttachmentSegment));
  return [...ids].filter((id) => owners.has(parseThreadSegmentFromAttachmentId(id)));
});
