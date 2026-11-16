import { MessageId, ThreadId, type OrchestrationV2MessageSpeaker } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/**
 * Speaker label and model for message items that carry both. The type list and `json_valid`
 * term match the message-ordinal index. Speaker fields sit outside that index, so each hit
 * decodes the payload.
 */
export const readPeerSpeakers = Effect.fn("ReadPeerSpeakers.read")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  messageIds?: ReadonlyArray<MessageId>,
) {
  const speakers = new Map<MessageId, OrchestrationV2MessageSpeaker>();
  if (messageIds !== undefined && messageIds.length === 0) return speakers;
  const rows = yield* sql<{
    readonly message_id: string;
    readonly label: string | null;
    readonly model: string | null;
  }>`
    SELECT json_extract(payload_json, '$.messageId') AS message_id,
      json_extract(payload_json, '$.speaker.label') AS label,
      json_extract(payload_json, '$.speaker.model') AS model
    FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ${threadId}
      AND type IN ('user_message', 'assistant_message')
      AND json_valid(payload_json)
      AND json_extract(payload_json, '$.speaker.label') IS NOT NULL
      AND json_extract(payload_json, '$.speaker.model') IS NOT NULL
      ${
        messageIds === undefined
          ? sql``
          : sql`AND json_extract(payload_json, '$.messageId') IN (SELECT value FROM json_each(${encodeIds(messageIds)}))`
      }
  `;
  for (const row of rows) {
    if (row.label && row.model)
      speakers.set(MessageId.make(row.message_id), { label: row.label, model: row.model });
  }
  return speakers;
});
