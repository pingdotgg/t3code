import { ThreadId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import {
  directThreadWaits,
  createMentionedThreadResolver,
} from "@t3tools/shared/threadReferenceRelationships";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const decodeWaitItem = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      runId: Schema.NullOr(Schema.String),
      type: Schema.String,
      status: Schema.String,
      toolName: Schema.optional(Schema.NullOr(Schema.String)),
      input: Schema.optional(Schema.Unknown),
    }),
  ),
);

/** Reads links from stored messages, including streaming and subagent messages omitted by search. */
export const findThreadReferences = Effect.fn("ThreadReferences.find")(function* (input: {
  readonly sql: SqlClient.SqlClient;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly target: ScopedThreadRef;
  readonly knownThreads: ReadonlyArray<ScopedThreadRef>;
}) {
  const { sql, sourceEnvironmentId, target } = input;
  const threadRows = yield* sql<{
    thread_id: string;
  }>`SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL`;
  const known = [
    ...input.knownThreads,
    ...threadRows.map((row) => ({
      environmentId: sourceEnvironmentId,
      threadId: ThreadId.make(row.thread_id),
    })),
  ];
  // Remove duplicates before legacy-link ambiguity is checked.
  const unique = [
    ...new Map(
      known.map((ref) => [JSON.stringify([ref.environmentId, ref.threadId]), ref]),
    ).values(),
  ];
  const messages = yield* sql<{ thread_id: string; text: string }>`
    SELECT m.thread_id, json_extract(m.payload_json, '$.text') AS text
    FROM orchestration_v2_projection_messages m INDEXED BY orchestration_v2_message_thread_links_idx
    JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id AND t.deleted_at IS NULL
    WHERE (instr(m.payload_json, 't3-thread://') > 0 OR instr(m.payload_json, 'app.t3.codes/threads/') > 0)
  `;
  const isTarget = (ref: ScopedThreadRef) =>
    ref.environmentId === target.environmentId && ref.threadId === target.threadId;
  const resolveMentions = createMentionedThreadResolver(sourceEnvironmentId, unique);
  const mentions = new Set(
    messages
      .filter((row) => typeof row.text === "string" && resolveMentions(row.text).some(isTarget))
      .map((row) => ThreadId.make(row.thread_id)),
  );
  const contexts = yield* sql<{ thread_id: string; text: string; context_id: string }>`
    SELECT m.thread_id, json_extract(m.payload_json, '$.text') AS text,
      json_extract(record.value, '$.contextId') AS context_id
    FROM orchestration_v2_projection_messages m INDEXED BY orchestration_v2_message_context_refs_idx
    JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id AND t.deleted_at IS NULL,
      json_each(m.payload_json, '$.context.records') record
    WHERE json_type(m.payload_json, '$.context.records') = 'array'
      AND CASE WHEN record.type = 'object' THEN
      json_extract(record.value, '$.kind') = 'thread'
      AND json_extract(record.value, '$.environmentId') = ${target.environmentId}
      AND json_extract(record.value, '$.threadId') = ${target.threadId}
      ELSE 0 END
  `;
  for (const row of contexts) {
    if (
      typeof row.text === "string" &&
      collectComposerContextReferences(row.text).some(
        (ref) => ref.kind === "thread" && ref.contextId === row.context_id,
      )
    ) {
      mentions.add(ThreadId.make(row.thread_id));
    }
  }
  const items = yield* sql<{ thread_id: string; run_id: string; payload_json: string }>`
    SELECT i.thread_id, i.run_id, i.payload_json
    FROM orchestration_v2_projection_turn_items i
    JOIN orchestration_v2_projection_runs r ON r.run_id = i.run_id AND r.status = 'running'
    JOIN orchestration_v2_projection_threads t ON t.thread_id = i.thread_id AND t.deleted_at IS NULL
    WHERE i.type = 'dynamic_tool' AND i.status IN ('running', 'waiting')
  `;
  const waits = new Set<ThreadId>();
  for (const row of items) {
    const item = yield* decodeWaitItem(row.payload_json);
    if (
      directThreadWaits({
        environmentId: sourceEnvironmentId,
        activeRunId: row.run_id,
        items: [item],
      }).some(isTarget)
    )
      waits.add(ThreadId.make(row.thread_id));
  }
  // A blocking app-owned delegation retains settled_only while its originating run is live.
  const delegates = yield* sql<{ thread_id: string }>`
    SELECT s.thread_id
    FROM orchestration_v2_projection_subagents s
    JOIN orchestration_v2_projection_runs r ON r.run_id = s.run_id AND r.status = 'running'
    JOIN orchestration_v2_projection_threads t ON t.thread_id = s.thread_id AND t.deleted_at IS NULL
    WHERE s.origin = 'app_owned' AND s.status IN ('pending', 'running', 'waiting')
      AND coalesce(json_extract(s.payload_json, '$.completionWake'), 'settled_only') = 'settled_only'
      AND ((s.child_thread_id = ${target.threadId} AND ${sourceEnvironmentId} = ${target.environmentId})
        OR (json_extract(s.payload_json, '$.remoteChild.threadId') = ${target.threadId}
          AND json_extract(s.payload_json, '$.remoteChild.environmentId') = ${target.environmentId}))
  `;
  for (const row of delegates) waits.add(ThreadId.make(row.thread_id));
  return { mentions: [...mentions], waits: [...waits] };
});
