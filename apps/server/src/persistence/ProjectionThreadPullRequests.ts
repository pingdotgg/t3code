import { normalizeThreadPullRequestKey } from "@t3tools/shared/threadPullRequests";
import {
  IsoDateTime,
  PositiveInt,
  ThreadId,
  ThreadPullRequestKey,
  ThreadPullRequestLinkSource,
  ThreadPullRequestSnapshot,
  ThreadPullRequestStack,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "./Errors.ts";

import * as Layer from "effect/Layer";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export const ProjectionThreadPullRequest = Schema.Struct({
  threadId: ThreadId,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  source: ThreadPullRequestLinkSource,
  linkedAt: IsoDateTime,
  snapshot: Schema.NullOr(ThreadPullRequestSnapshot),
  stack: Schema.NullOr(ThreadPullRequestStack),
});
export type ProjectionThreadPullRequest = typeof ProjectionThreadPullRequest.Type;

export const ListProjectionThreadPullRequestsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadPullRequestsInput =
  typeof ListProjectionThreadPullRequestsInput.Type;

export const ListProjectionThreadPullRequestsByPullRequestInput = ThreadPullRequestKey;
export type ListProjectionThreadPullRequestsByPullRequestInput =
  typeof ListProjectionThreadPullRequestsByPullRequestInput.Type;

export const DeleteProjectionThreadPullRequestInput = Schema.Struct({
  threadId: ThreadId,
  ...ThreadPullRequestKey.fields,
});
export type DeleteProjectionThreadPullRequestInput =
  typeof DeleteProjectionThreadPullRequestInput.Type;

export const DeleteProjectionThreadPullRequestsInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadPullRequestsInput =
  typeof DeleteProjectionThreadPullRequestsInput.Type;

export const DeleteProjectionThreadPullRequestsBySourceInput = Schema.Struct({
  threadId: ThreadId,
  source: ThreadPullRequestLinkSource,
});
export type DeleteProjectionThreadPullRequestsBySourceInput =
  typeof DeleteProjectionThreadPullRequestsBySourceInput.Type;

const ProjectionThreadPullRequestDbRow = ProjectionThreadPullRequest.mapFields(
  Struct.assign({
    snapshot: Schema.NullOr(Schema.fromJsonString(ThreadPullRequestSnapshot)),
    stack: Schema.NullOr(Schema.fromJsonString(ThreadPullRequestStack)),
  }),
);

export class ProjectionThreadPullRequestRepository extends Context.Service<
  ProjectionThreadPullRequestRepository,
  {
    readonly upsert: (
      row: ProjectionThreadPullRequest,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly listByThreadId: (
      input: ListProjectionThreadPullRequestsInput,
    ) => Effect.Effect<ReadonlyArray<ProjectionThreadPullRequest>, ProjectionRepositoryError>;
    readonly listByPullRequest: (
      input: ListProjectionThreadPullRequestsByPullRequestInput,
    ) => Effect.Effect<ReadonlyArray<ProjectionThreadPullRequest>, ProjectionRepositoryError>;
    readonly delete: (
      input: DeleteProjectionThreadPullRequestInput,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly deleteByThreadId: (
      input: DeleteProjectionThreadPullRequestsInput,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly deleteByThreadIdAndSource: (
      input: DeleteProjectionThreadPullRequestsBySourceInput,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
  }
>()("t3/persistence/ProjectionThreadPullRequests/ProjectionThreadPullRequestRepository") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadPullRequestRow = SqlSchema.void({
    Request: ProjectionThreadPullRequest,
    execute: (row) => sql`
      INSERT INTO projection_thread_pull_requests (
        thread_id,
        host,
        repository,
        number,
        url,
        source,
        linked_at,
        snapshot_json,
        stack_json
      )
      VALUES (
        ${row.threadId},
        ${row.host},
        ${row.repository},
        ${row.number},
        ${row.url},
        ${row.source},
        ${row.linkedAt},
        ${row.snapshot === null ? null : JSON.stringify(row.snapshot)},
        ${row.stack === null ? null : JSON.stringify(row.stack)}
      )
      ON CONFLICT (thread_id, host, repository, number)
      DO UPDATE SET
        url = excluded.url,
        source = excluded.source,
        linked_at = excluded.linked_at,
        snapshot_json = excluded.snapshot_json,
        stack_json = excluded.stack_json
    `,
  });

  const listProjectionThreadPullRequestRows = SqlSchema.findAll({
    Request: ListProjectionThreadPullRequestsInput,
    Result: ProjectionThreadPullRequestDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        host,
        repository,
        number,
        url,
        source,
        linked_at AS "linkedAt",
        snapshot_json AS "snapshot",
        stack_json AS "stack"
      FROM projection_thread_pull_requests
      WHERE thread_id = ${threadId}
      ORDER BY linked_at ASC, number ASC
    `,
  });

  const listProjectionThreadPullRequestRowsByPullRequest = SqlSchema.findAll({
    Request: ListProjectionThreadPullRequestsByPullRequestInput,
    Result: ProjectionThreadPullRequestDbRow,
    execute: ({ host, repository, number }) => sql`
      SELECT
        thread_id AS "threadId",
        host,
        repository,
        number,
        url,
        source,
        linked_at AS "linkedAt",
        snapshot_json AS "snapshot",
        stack_json AS "stack"
      FROM projection_thread_pull_requests
      WHERE host = ${host}
        AND repository = ${repository}
        AND number = ${number}
      ORDER BY linked_at ASC, thread_id ASC
    `,
  });

  const deleteProjectionThreadPullRequestRow = SqlSchema.void({
    Request: DeleteProjectionThreadPullRequestInput,
    execute: ({ threadId, host, repository, number }) => sql`
      DELETE FROM projection_thread_pull_requests
      WHERE thread_id = ${threadId}
        AND host = ${host}
        AND repository = ${repository}
        AND number = ${number}
    `,
  });

  const deleteProjectionThreadPullRequestRows = SqlSchema.void({
    Request: DeleteProjectionThreadPullRequestsInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_pull_requests
      WHERE thread_id = ${threadId}
    `,
  });

  const deleteProjectionThreadPullRequestRowsBySource = SqlSchema.void({
    Request: DeleteProjectionThreadPullRequestsBySourceInput,
    execute: ({ threadId, source }) => sql`
      DELETE FROM projection_thread_pull_requests
      WHERE thread_id = ${threadId}
        AND source = ${source}
    `,
  });

  const upsert: ProjectionThreadPullRequestRepository["Service"]["upsert"] = (row) =>
    upsertProjectionThreadPullRequestRow({ ...row, ...normalizeThreadPullRequestKey(row) }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadPullRequestRepository.upsert:query")),
    );

  const listByThreadId: ProjectionThreadPullRequestRepository["Service"]["listByThreadId"] = (
    input,
  ) =>
    listProjectionThreadPullRequestRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadPullRequestRepository.listByThreadId:query"),
      ),
    );

  const listByPullRequest: ProjectionThreadPullRequestRepository["Service"]["listByPullRequest"] = (
    input,
  ) =>
    listProjectionThreadPullRequestRowsByPullRequest(normalizeThreadPullRequestKey(input)).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadPullRequestRepository.listByPullRequest:query"),
      ),
    );

  const deleteLink: ProjectionThreadPullRequestRepository["Service"]["delete"] = (input) =>
    deleteProjectionThreadPullRequestRow({
      ...input,
      ...normalizeThreadPullRequestKey(input),
    }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadPullRequestRepository.delete:query")),
    );

  const deleteByThreadId: ProjectionThreadPullRequestRepository["Service"]["deleteByThreadId"] = (
    input,
  ) =>
    deleteProjectionThreadPullRequestRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadPullRequestRepository.deleteByThreadId:query"),
      ),
    );

  const deleteByThreadIdAndSource: ProjectionThreadPullRequestRepository["Service"]["deleteByThreadIdAndSource"] =
    (input) =>
      deleteProjectionThreadPullRequestRowsBySource(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadPullRequestRepository.deleteByThreadIdAndSource:query",
          ),
        ),
      );

  return {
    upsert,
    listByThreadId,
    listByPullRequest,
    delete: deleteLink,
    deleteByThreadId,
    deleteByThreadIdAndSource,
  } satisfies ProjectionThreadPullRequestRepository["Service"];
});

export const layer = Layer.effect(ProjectionThreadPullRequestRepository, make);
