import {
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  NonNegativeInt,
  OrchestrationProposedPlanId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "./Errors.ts";
import type { ProjectionRepositoryError } from "./Errors.ts";

export const ProjectionQueuedTurnStatus = Schema.Literals(["queued", "handoff"]);

export const ProjectionQueuedTurn = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  eventId: EventId,
  commandId: CommandId,
  modelSelection: Schema.NullOr(ModelSelection),
  titleSeed: Schema.NullOr(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  queuedAt: IsoDateTime,
  eventSequence: NonNegativeInt,
  status: ProjectionQueuedTurnStatus,
});
export type ProjectionQueuedTurn = typeof ProjectionQueuedTurn.Type;

export const ProjectionQueuedTurnMessageInput = Schema.Struct({
  messageId: MessageId,
});
export const ProjectionQueuedTurnThreadInput = Schema.Struct({
  threadId: ThreadId,
});

export class ProjectionQueuedTurnRepository extends Context.Service<
  ProjectionQueuedTurnRepository,
  {
    readonly upsert: (row: ProjectionQueuedTurn) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly markHandoff: (
      input: typeof ProjectionQueuedTurnMessageInput.Type,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly deleteByMessageId: (
      input: typeof ProjectionQueuedTurnMessageInput.Type,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly deleteHandoffByThreadId: (
      input: typeof ProjectionQueuedTurnThreadInput.Type,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly deleteByThreadId: (
      input: typeof ProjectionQueuedTurnThreadInput.Type,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly listByThreadId: (
      input: typeof ProjectionQueuedTurnThreadInput.Type,
    ) => Effect.Effect<ReadonlyArray<ProjectionQueuedTurn>, ProjectionRepositoryError>;
    readonly listAll: Effect.Effect<ReadonlyArray<ProjectionQueuedTurn>, ProjectionRepositoryError>;
  }
>()("t3/persistence/ProjectionQueuedTurns/ProjectionQueuedTurnRepository") {}

const ProjectionQueuedTurnDbRow = Schema.Struct({
  ...ProjectionQueuedTurn.fields,
  modelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionQueuedTurn,
    execute: (row) => sql`
      INSERT INTO projection_thread_turn_queue (
        message_id,
        thread_id,
        event_id,
        command_id,
        model_selection_json,
        title_seed,
        runtime_mode,
        interaction_mode,
        source_proposed_plan_thread_id,
        source_proposed_plan_id,
        queued_at,
        event_sequence,
        status
      ) VALUES (
        ${row.messageId},
        ${row.threadId},
        ${row.eventId},
        ${row.commandId},
        ${row.modelSelection === null ? null : JSON.stringify(row.modelSelection)},
        ${row.titleSeed},
        ${row.runtimeMode},
        ${row.interactionMode},
        ${row.sourceProposedPlanThreadId},
        ${row.sourceProposedPlanId},
        ${row.queuedAt},
        ${row.eventSequence},
        ${row.status}
      )
      ON CONFLICT (message_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        event_id = excluded.event_id,
        command_id = excluded.command_id,
        model_selection_json = excluded.model_selection_json,
        title_seed = excluded.title_seed,
        runtime_mode = excluded.runtime_mode,
        interaction_mode = excluded.interaction_mode,
        source_proposed_plan_thread_id = excluded.source_proposed_plan_thread_id,
        source_proposed_plan_id = excluded.source_proposed_plan_id,
        queued_at = excluded.queued_at,
        event_sequence = excluded.event_sequence,
        status = excluded.status
    `,
  });

  const markHandoffRow = SqlSchema.void({
    Request: ProjectionQueuedTurnMessageInput,
    execute: ({ messageId }) => sql`
      UPDATE projection_thread_turn_queue
      SET status = 'handoff'
      WHERE message_id = ${messageId}
        AND status = 'queued'
    `,
  });

  const deleteMessageRow = SqlSchema.void({
    Request: ProjectionQueuedTurnMessageInput,
    execute: ({ messageId }) => sql`
      DELETE FROM projection_thread_turn_queue
      WHERE message_id = ${messageId}
    `,
  });

  const deleteHandoffThreadRows = SqlSchema.void({
    Request: ProjectionQueuedTurnThreadInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_turn_queue
      WHERE thread_id = ${threadId}
        AND status = 'handoff'
    `,
  });

  const deleteThreadRows = SqlSchema.void({
    Request: ProjectionQueuedTurnThreadInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_turn_queue
      WHERE thread_id = ${threadId}
    `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: ProjectionQueuedTurnThreadInput,
    Result: ProjectionQueuedTurnDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        event_id AS "eventId",
        command_id AS "commandId",
        model_selection_json AS "modelSelection",
        title_seed AS "titleSeed",
        runtime_mode AS "runtimeMode",
        interaction_mode AS "interactionMode",
        source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
        source_proposed_plan_id AS "sourceProposedPlanId",
        queued_at AS "queuedAt",
        event_sequence AS "eventSequence",
        status
      FROM projection_thread_turn_queue
      WHERE thread_id = ${threadId}
      ORDER BY event_sequence ASC
    `,
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionQueuedTurnDbRow,
    execute: () => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        event_id AS "eventId",
        command_id AS "commandId",
        model_selection_json AS "modelSelection",
        title_seed AS "titleSeed",
        runtime_mode AS "runtimeMode",
        interaction_mode AS "interactionMode",
        source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
        source_proposed_plan_id AS "sourceProposedPlanId",
        queued_at AS "queuedAt",
        event_sequence AS "eventSequence",
        status
      FROM projection_thread_turn_queue
      ORDER BY event_sequence ASC
    `,
  });

  const mapError = (operation: string) =>
    Effect.mapError((cause: unknown) =>
      Schema.isSchemaError(cause)
        ? toPersistenceDecodeError(`${operation}:decode`)(cause)
        : toPersistenceSqlError(operation)(cause),
    );
  const upsert: ProjectionQueuedTurnRepository["Service"]["upsert"] = (row) =>
    upsertRow(row).pipe(mapError("ProjectionQueuedTurnRepository.upsert:query"));
  const markHandoff: ProjectionQueuedTurnRepository["Service"]["markHandoff"] = (input) =>
    markHandoffRow(input).pipe(mapError("ProjectionQueuedTurnRepository.markHandoff:query"));
  const deleteByMessageId: ProjectionQueuedTurnRepository["Service"]["deleteByMessageId"] = (
    input,
  ) =>
    deleteMessageRow(input).pipe(
      mapError("ProjectionQueuedTurnRepository.deleteByMessageId:query"),
    );
  const deleteHandoffByThreadId: ProjectionQueuedTurnRepository["Service"]["deleteHandoffByThreadId"] =
    (input) =>
      deleteHandoffThreadRows(input).pipe(
        mapError("ProjectionQueuedTurnRepository.deleteHandoffByThreadId:query"),
      );
  const deleteByThreadId: ProjectionQueuedTurnRepository["Service"]["deleteByThreadId"] = (input) =>
    deleteThreadRows(input).pipe(mapError("ProjectionQueuedTurnRepository.deleteByThreadId:query"));
  const listByThreadId: ProjectionQueuedTurnRepository["Service"]["listByThreadId"] = (input) =>
    listThreadRows(input).pipe(mapError("ProjectionQueuedTurnRepository.listByThreadId:query"));
  const listAll: ProjectionQueuedTurnRepository["Service"]["listAll"] = listAllRows(undefined).pipe(
    mapError("ProjectionQueuedTurnRepository.listAll:query"),
  );

  return {
    upsert,
    markHandoff,
    deleteByMessageId,
    deleteHandoffByThreadId,
    deleteByThreadId,
    listByThreadId,
    listAll,
  } satisfies ProjectionQueuedTurnRepository["Service"];
});

export const layer = Layer.effect(ProjectionQueuedTurnRepository, make);
