import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionTaskInput,
  GetProjectionTaskInput,
  ProjectionTask,
  ProjectionTaskRepository,
  type ProjectionTaskRepositoryShape,
} from "../Services/ProjectionTasks.ts";

const makeProjectionTaskRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionTaskRow = SqlSchema.void({
    Request: ProjectionTask,
    execute: (row) =>
      sql`
        INSERT INTO projection_tasks (
          task_id,
          name,
          description,
          primary_project_id,
          archived_at,
          settled_override,
          settled_at,
          unsettled_at,
          snoozed_until,
          snoozed_at,
          pinned_at,
          pin_order_key,
          active_order_key,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.taskId},
          ${row.name},
          ${row.description},
          ${row.primaryProjectId},
          ${row.archivedAt},
          ${row.settledOverride},
          ${row.settledAt},
          ${row.unsettledAt},
          ${row.snoozedUntil},
          ${row.snoozedAt},
          ${row.pinnedAt},
          ${row.pinOrderKey},
          ${row.activeOrderKey},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (task_id)
        DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          primary_project_id = excluded.primary_project_id,
          archived_at = excluded.archived_at,
          settled_override = excluded.settled_override,
          settled_at = excluded.settled_at,
          unsettled_at = excluded.unsettled_at,
          snoozed_until = excluded.snoozed_until,
          snoozed_at = excluded.snoozed_at,
          pinned_at = excluded.pinned_at,
          pin_order_key = excluded.pin_order_key,
          active_order_key = excluded.active_order_key,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionTaskRow = SqlSchema.findOneOption({
    Request: GetProjectionTaskInput,
    Result: ProjectionTask,
    execute: ({ taskId }) =>
      sql`
        SELECT
          task_id AS "taskId",
          name,
          description,
          primary_project_id AS "primaryProjectId",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          active_order_key AS "activeOrderKey",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_tasks
        WHERE task_id = ${taskId}
      `,
  });

  const listProjectionTaskRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionTask,
    execute: () =>
      sql`
        SELECT
          task_id AS "taskId",
          name,
          description,
          primary_project_id AS "primaryProjectId",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          active_order_key AS "activeOrderKey",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_tasks
        ORDER BY created_at ASC, task_id ASC
      `,
  });

  const deleteProjectionTaskRow = SqlSchema.void({
    Request: DeleteProjectionTaskInput,
    execute: ({ taskId }) => sql`DELETE FROM projection_tasks WHERE task_id = ${taskId}`,
  });

  const upsert: ProjectionTaskRepositoryShape["upsert"] = (row) =>
    upsertProjectionTaskRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.upsert:query")),
    );
  const getById: ProjectionTaskRepositoryShape["getById"] = (input) =>
    getProjectionTaskRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.getById:query")),
    );
  const listAll: ProjectionTaskRepositoryShape["listAll"] = () =>
    listProjectionTaskRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.listAll:query")),
    );
  const deleteById: ProjectionTaskRepositoryShape["deleteById"] = (input) =>
    deleteProjectionTaskRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.deleteById:query")),
    );

  return { upsert, getById, listAll, deleteById } satisfies ProjectionTaskRepositoryShape;
});

export const ProjectionTaskRepositoryLive = Layer.effect(
  ProjectionTaskRepository,
  makeProjectionTaskRepository,
);
