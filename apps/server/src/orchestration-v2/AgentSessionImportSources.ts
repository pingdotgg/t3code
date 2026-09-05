import {
  AgentSessionImportSource,
  AgentSessionScanError,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** File fingerprints are retry bookkeeping, independent of provider runtime sessions. */
export class AgentSessionImportSources extends Context.Service<
  AgentSessionImportSources,
  {
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<AgentSessionImportSource>, AgentSessionScanError>;
    readonly record: (
      threadId: ThreadId,
      source: AgentSessionImportSource,
    ) => Effect.Effect<void, AgentSessionScanError>;
  }
>()("t3/orchestration-v2/AgentSessionImportSources") {}

export const layer = Layer.effect(
  AgentSessionImportSources,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentSessionImportSource));
    const encode = Schema.encodeEffect(Schema.fromJsonString(AgentSessionImportSource));
    return AgentSessionImportSources.of({
      list: Effect.fn("AgentSessionImportSources.list")(
        function* (projectId) {
          const rows = yield* sql<{ readonly source_json: string }>`
        SELECT source.source_json
        FROM orchestration_v2_agent_session_import_sources AS source
        INNER JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = source.thread_id
        WHERE json_extract(thread.payload_json, '$.projectId') = ${projectId}
          AND json_extract(thread.payload_json, '$.deletedAt') IS NULL
          AND json_extract(thread.payload_json, '$.archivedAt') IS NULL
      `;
          return yield* Effect.forEach(rows, (row) => decode(row.source_json));
        },
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      ),
      record: Effect.fn("AgentSessionImportSources.record")(
        function* (threadId, source) {
          const encoded = yield* encode(source);
          yield* sql`
        INSERT INTO orchestration_v2_agent_session_import_sources (thread_id, file_path, source_json)
        VALUES (${threadId}, ${source.filePath}, ${encoded})
        ON CONFLICT(thread_id, file_path) DO UPDATE SET source_json = excluded.source_json
      `;
        },
        Effect.mapError(
          (cause) => new AgentSessionScanError({ operation: "read-projects", cause }),
        ),
      ),
    });
  }),
);
