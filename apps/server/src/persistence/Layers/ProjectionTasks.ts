import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  ProjectionTask,
  ProjectionTaskRepository,
  type ProjectionTaskRepositoryShape,
  DeleteProjectionTaskInput,
  GetProjectionTaskInput,
  ListProjectionTasksByProjectInput,
} from "../Services/ProjectionTasks.ts";

const makeProjectionTaskRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionTaskRow = SqlSchema.void({
    Request: ProjectionTask,
    execute: (row) =>
      sql`
        INSERT INTO projection_tasks (
          task_id,
          project_id,
          thread_id,
          name,
          prompt,
          schedule_json,
          created_at,
          updated_at,
          last_fired_at,
          next_fire_at,
          cancelled_at
        )
        VALUES (
          ${row.taskId},
          ${row.projectId},
          ${row.threadId},
          ${row.name ?? null},
          ${row.prompt},
          ${row.scheduleJson},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.lastFiredAt},
          ${row.nextFireAt},
          ${row.cancelledAt}
        )
        ON CONFLICT (task_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          thread_id = excluded.thread_id,
          name = excluded.name,
          prompt = excluded.prompt,
          schedule_json = excluded.schedule_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          last_fired_at = excluded.last_fired_at,
          next_fire_at = excluded.next_fire_at,
          cancelled_at = excluded.cancelled_at
      `,
  });

  const getProjectionTaskRow = SqlSchema.findOneOption({
    Request: GetProjectionTaskInput,
    Result: ProjectionTask,
    execute: ({ taskId }) =>
      sql`
        SELECT
          task_id AS "taskId",
          project_id AS "projectId",
          thread_id AS "threadId",
          name,
          prompt,
          schedule_json AS "scheduleJson",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_fired_at AS "lastFiredAt",
          next_fire_at AS "nextFireAt",
          cancelled_at AS "cancelledAt"
        FROM projection_tasks
        WHERE task_id = ${taskId}
      `,
  });

  const listProjectionTaskRowsByProject = SqlSchema.findAll({
    Request: ListProjectionTasksByProjectInput,
    Result: ProjectionTask,
    execute: ({ projectId }) =>
      sql`
        SELECT
          task_id AS "taskId",
          project_id AS "projectId",
          thread_id AS "threadId",
          name,
          prompt,
          schedule_json AS "scheduleJson",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_fired_at AS "lastFiredAt",
          next_fire_at AS "nextFireAt",
          cancelled_at AS "cancelledAt"
        FROM projection_tasks
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, task_id ASC
      `,
  });

  const deleteProjectionTaskRow = SqlSchema.void({
    Request: DeleteProjectionTaskInput,
    execute: ({ taskId }) =>
      sql`
        DELETE FROM projection_tasks
        WHERE task_id = ${taskId}
      `,
  });

  const upsert: ProjectionTaskRepositoryShape["upsert"] = (row) =>
    upsertProjectionTaskRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.upsert:query")),
    );

  const getById: ProjectionTaskRepositoryShape["getById"] = (input) =>
    getProjectionTaskRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.getById:query")),
    );

  const listByProjectId: ProjectionTaskRepositoryShape["listByProjectId"] = (input) =>
    listProjectionTaskRowsByProject(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.listByProjectId:query")),
    );

  const deleteById: ProjectionTaskRepositoryShape["deleteById"] = (input) =>
    deleteProjectionTaskRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTaskRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    deleteById,
  } satisfies ProjectionTaskRepositoryShape;
});

export const ProjectionTaskRepositoryLive = Layer.effect(
  ProjectionTaskRepository,
  makeProjectionTaskRepository,
);
