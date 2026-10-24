import * as Context from "effect/Context";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { SourceControlProviderKind } from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type PullRequestFilesViewedRepositoryError,
} from "./Errors.ts";

export const PullRequestFilesViewedScope = Schema.Struct({
  provider: SourceControlProviderKind,
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  viewer: Schema.String,
});
export type PullRequestFilesViewedScope = typeof PullRequestFilesViewedScope.Type;

export const PullRequestFileViewedMark = Schema.Struct({
  path: Schema.String,
  /**
   * Empty where the host said it had none to give, which is an answer rather than a gap: a file
   * with no version at the head is one the change request deletes. Null where the host could
   * not say at all, which is no baseline rather than an empty one, and such a mark stays
   * cleared until a press replaces it.
   */
  revision: Schema.NullOr(Schema.String),
});
export type PullRequestFileViewedMark = typeof PullRequestFileViewedMark.Type;

export interface SetPullRequestFilesViewedInput extends PullRequestFilesViewedScope {
  readonly files: ReadonlyArray<PullRequestFileViewedMark & { readonly viewed: boolean }>;
  readonly viewedAt: string;
}

export const MAX_FILES_VIEWED_ROWS = 500;

export interface PullRequestFilesViewedPage {
  readonly files: ReadonlyArray<PullRequestFileViewedMark>;
  readonly truncated: boolean;
}

export class PullRequestFilesViewedRepository extends Context.Service<
  PullRequestFilesViewedRepository,
  {
    readonly list: (
      input: PullRequestFilesViewedScope,
    ) => Effect.Effect<PullRequestFilesViewedPage, PullRequestFilesViewedRepositoryError>;
    readonly set: (
      input: SetPullRequestFilesViewedInput,
    ) => Effect.Effect<void, PullRequestFilesViewedRepositoryError>;
  }
>()("t3/persistence/PullRequestFilesViewed/PullRequestFilesViewedRepository") {}

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): PullRequestFilesViewedRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: PullRequestFilesViewedScope,
    Result: PullRequestFileViewedMark,
    execute: ({ provider, host, repository, number, viewer }) =>
      sql`
        SELECT
          path AS "path",
          revision AS "revision"
        FROM pull_request_files_viewed
        WHERE provider = ${provider}
          AND host = ${host}
          AND repository = ${repository}
          AND number = ${number}
          AND viewer = ${viewer}
        ORDER BY path
        LIMIT ${MAX_FILES_VIEWED_ROWS + 1}
      `,
  });

  return PullRequestFilesViewedRepository.of({
    list: (input) =>
      listRows(input).pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => ({
          files: rows.slice(0, MAX_FILES_VIEWED_ROWS),
          truncated: rows.length > MAX_FILES_VIEWED_ROWS,
        })),
        Effect.mapError(toSqlOrDecodeError("listPullRequestFilesViewed", "PullRequestFileViewed")),
      ),

    set: (input) =>
      sql
        .withTransaction(
          Effect.forEach(
            input.files,
            (file) =>
              file.viewed
                ? sql`
                INSERT INTO pull_request_files_viewed (
                  provider,
                  host,
                  repository,
                  number,
                  viewer,
                  path,
                  revision,
                  viewed_at
                )
                VALUES (
                  ${input.provider},
                  ${input.host},
                  ${input.repository},
                  ${input.number},
                  ${input.viewer},
                  ${file.path},
                  ${file.revision},
                  ${input.viewedAt}
                )
                ON CONFLICT (provider, host, repository, number, viewer, path)
                DO UPDATE SET revision = excluded.revision, viewed_at = excluded.viewed_at
              `
                : sql`
                DELETE FROM pull_request_files_viewed
                WHERE provider = ${input.provider}
                  AND host = ${input.host}
                  AND repository = ${input.repository}
                  AND number = ${input.number}
                  AND viewer = ${input.viewer}
                  AND path = ${file.path}
              `,
            { discard: true },
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) => new PersistenceSqlError({ operation: "setPullRequestFilesViewed", cause }),
          ),
        ),
  });
});

export const layer = Layer.effect(PullRequestFilesViewedRepository, make);
