import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

interface LegacyV2EventRow {
  readonly event_id: string;
  readonly command_id: string | null;
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly node_id: string | null;
  readonly driver: string | null;
  readonly provider_instance_id: string | null;
  readonly raw_event_id: string | null;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly payload_json: string;
}

interface ProjectProjectionRow {
  readonly project_id: string;
  readonly title: string;
  readonly workspace_root: string;
  readonly default_model_selection_json: string | null;
  readonly scripts_json: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeJson = Schema.encodeEffect(Schema.UnknownFromJsonString);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE orchestration_events
    ADD COLUMN application_event_version INTEGER NOT NULL DEFAULT 1
  `;
  yield* sql`
    CREATE INDEX idx_orchestration_events_application_sequence
    ON orchestration_events(application_event_version, sequence)
  `;
  yield* sql`
    ALTER TABLE orchestration_command_receipts
    ADD COLUMN command_type TEXT NOT NULL DEFAULT 'legacy'
  `;

  const legacyV2Events = yield* sql<LegacyV2EventRow>`
    SELECT
      event_id,
      command_id,
      thread_id,
      run_id,
      node_id,
      driver,
      provider_instance_id,
      raw_event_id,
      event_type,
      occurred_at,
      payload_json
    FROM orchestration_v2_events
    ORDER BY sequence ASC
  `;

  yield* Effect.forEach(
    legacyV2Events,
    (event) =>
      Effect.gen(function* () {
        const metadata = yield* encodeJson({
          applicationEventVersion: 2,
          ...(event.run_id === null ? {} : { runId: event.run_id }),
          ...(event.node_id === null ? {} : { nodeId: event.node_id }),
          ...(event.driver === null ? {} : { driver: event.driver }),
          ...(event.provider_instance_id === null
            ? {}
            : { providerInstanceId: event.provider_instance_id }),
          ...(event.raw_event_id === null ? {} : { rawEventId: event.raw_event_id }),
        });
        yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json,
          application_event_version
        )
        SELECT
          ${event.event_id},
          'thread',
          ${event.thread_id},
          COALESCE(
            (
              SELECT MAX(stream_version) + 1
              FROM orchestration_events
              WHERE aggregate_kind = 'thread' AND stream_id = ${event.thread_id}
            ),
            0
          ),
          ${event.event_type},
          ${event.occurred_at},
          ${event.command_id},
          NULL,
          ${event.command_id},
          ${event.raw_event_id === null ? "server" : "provider"},
          ${event.payload_json},
          ${metadata},
          2
        WHERE NOT EXISTS (
          SELECT 1 FROM orchestration_events WHERE event_id = ${event.event_id}
        )
        `;
      }),
    { concurrency: 1, discard: true },
  );

  // ProjectService wrote this projection directly before the application event
  // boundary was restored. Re-baseline every current row into the shared log so
  // projection rebuilds preserve the exact pre-migration project state.
  const projectRows = yield* sql<ProjectProjectionRow>`
    SELECT
      project_id,
      title,
      workspace_root,
      default_model_selection_json,
      scripts_json,
      created_at,
      updated_at,
      deleted_at
    FROM projection_projects
    ORDER BY created_at ASC, project_id ASC
  `;
  yield* Effect.forEach(
    projectRows,
    (project) =>
      Effect.gen(function* () {
        const createdEventId = `migration:38:project:${project.project_id}:baseline`;
        const createdPayload = {
          projectId: project.project_id,
          title: project.title,
          workspaceRoot: project.workspace_root,
          defaultModelSelection:
            project.default_model_selection_json === null
              ? null
              : yield* decodeJson(project.default_model_selection_json),
          scripts: yield* decodeJson(project.scripts_json),
          createdAt: project.created_at,
          updatedAt: project.updated_at,
        };
        const createdPayloadJson = yield* encodeJson(createdPayload);
        const migrationMetadataJson = yield* encodeJson({
          applicationEventVersion: 2,
          migration: 38,
        });
        yield* sql`
          INSERT INTO orchestration_events (
            event_id,
            aggregate_kind,
            stream_id,
            stream_version,
            event_type,
            occurred_at,
            command_id,
            causation_event_id,
            correlation_id,
            actor_kind,
            payload_json,
            metadata_json,
            application_event_version
          )
          VALUES (
            ${createdEventId},
            'project',
            ${project.project_id},
            COALESCE(
              (
                SELECT MAX(stream_version) + 1
                FROM orchestration_events
                WHERE aggregate_kind = 'project' AND stream_id = ${project.project_id}
              ),
              0
            ),
            'project.created',
            ${project.updated_at},
            NULL,
            NULL,
            NULL,
            'server',
            ${createdPayloadJson},
            ${migrationMetadataJson},
            2
          )
        `;

        if (project.deleted_at !== null) {
          const deletedPayloadJson = yield* encodeJson({
            projectId: project.project_id,
            deletedAt: project.deleted_at,
          });
          yield* sql`
            INSERT INTO orchestration_events (
              event_id,
              aggregate_kind,
              stream_id,
              stream_version,
              event_type,
              occurred_at,
              command_id,
              causation_event_id,
              correlation_id,
              actor_kind,
              payload_json,
              metadata_json,
              application_event_version
            )
            VALUES (
              ${`migration:38:project:${project.project_id}:deleted`},
              'project',
              ${project.project_id},
              (
                SELECT MAX(stream_version) + 1
                FROM orchestration_events
                WHERE aggregate_kind = 'project' AND stream_id = ${project.project_id}
              ),
              'project.deleted',
              ${project.deleted_at},
              NULL,
              ${createdEventId},
              NULL,
              'server',
              ${deletedPayloadJson},
              ${migrationMetadataJson},
              2
            )
          `;
        }
      }),
    { concurrency: 1, discard: true },
  );

  yield* sql`
    INSERT INTO orchestration_command_receipts (
      command_id,
      aggregate_kind,
      aggregate_id,
      accepted_at,
      result_sequence,
      status,
      error,
      command_type
    )
    SELECT
      command_id,
      'thread',
      thread_id,
      accepted_at,
      COALESCE(
        (
          SELECT MAX(events.sequence)
          FROM orchestration_events events
          WHERE events.application_event_version = 2
            AND events.command_id = receipts.command_id
        ),
        0
      ),
      status,
      error,
      command_type
    FROM orchestration_v2_command_receipts receipts
    WHERE TRUE
    ON CONFLICT(command_id) DO NOTHING
  `;
});
