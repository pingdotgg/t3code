import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { SourceControlProviderKind } from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type PullRequestFilesViewedRepositoryError,
} from "./Errors.ts";

/**
 * Which change request, on which host, for which reader.
 *
 * The host is part of it because a repository path is not unique across installs: the same
 * `group/project` exists on gitlab.com and on a self-managed instance, and a mark made against one
 * must not turn up on the other. The reader is part of it for the same reason the host's own
 * record is per-account: signing in as somebody else must not inherit their ticks. A host that
 * will not say who the reader is leaves it empty, which is one reader rather than none.
 */
export const PullRequestFilesViewedScope = Schema.Struct({
  provider: SourceControlProviderKind,
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  viewer: Schema.String,
});
export type PullRequestFilesViewedScope = typeof PullRequestFilesViewedScope.Type;

/** A file this reader cleared, and what it was when they cleared it. */
export const PullRequestFileViewedMark = Schema.Struct({
  path: Schema.String,
  /**
   * The host's own name for that version of the file, opaque here.
   *
   * Empty where the host said it had none to give, which is its own answer rather than a missing
   * one: a file with no version at the head is one the change request deletes, and it stays
   * deleted. Null where the host could not say at all, which is no baseline rather than an empty
   * one: stamping such a mark with the empty revision would report the file as changed the moment
   * anything did answer, so a mark with no baseline stays cleared until a press replaces it.
   */
  revision: Schema.NullOr(Schema.String),
});
export type PullRequestFileViewedMark = typeof PullRequestFileViewedMark.Type;

export interface SetPullRequestFilesViewedInput extends PullRequestFilesViewedScope {
  readonly files: ReadonlyArray<PullRequestFileViewedMark & { readonly viewed: boolean }>;
  /** When the presses landed, as an ISO instant. */
  readonly viewedAt: string;
}

/**
 * The marks this environment keeps for hosts that keep none of their own.
 *
 * Only cleared files are rows. Unticking deletes rather than writing a "not viewed" row, so the
 * table holds what a reader has done and not what they have merely scrolled past.
 */
export class PullRequestFilesViewedRepository extends Context.Service<
  PullRequestFilesViewedRepository,
  {
    readonly list: (
      input: PullRequestFilesViewedScope,
    ) => Effect.Effect<
      ReadonlyArray<PullRequestFileViewedMark>,
      PullRequestFilesViewedRepositoryError
    >;
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

export const make = Effect.gen(function* () {
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
      `,
  });

  return PullRequestFilesViewedRepository.of({
    list: (input) =>
      listRows(input).pipe(
        Effect.mapError(toSqlOrDecodeError("listPullRequestFilesViewed", "PullRequestFileViewed")),
      ),

    // One statement per file rather than one for the batch: the batch is what a reader ticked in
    // the last few hundred milliseconds, so it is a handful of rows on a local database, and a
    // mixed batch of clears and un-clears has no single statement anyway.
    set: (input) =>
      // One transaction for the batch. A press is a handful of files, and a failure part way
      // through would otherwise leave some of them cleared and the rest not, which the reader
      // sees on the next read as marks they never made.
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
