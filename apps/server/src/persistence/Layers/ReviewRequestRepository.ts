import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import {
  ReviewRequest,
  ReviewRequestStatus,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Effect, Layer, Schema } from "effect";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  ReviewRequestRepository,
  type ReviewRequestRepositoryShape,
  type ReviewRequestRepositoryError,
} from "../Services/ReviewRequestRepository.ts";

/**
 * DB row schema: thread_id comes back as string | null from SQLite,
 * so we map the optional field to NullOr for the database representation.
 */
const ReviewRequestDbRowSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  prUrl: Schema.String,
  prNumber: PositiveInt,
  prTitle: TrimmedNonEmptyString,
  repoNameWithOwner: TrimmedNonEmptyString,
  authorLogin: TrimmedNonEmptyString,
  isBot: Schema.Number,
  status: ReviewRequestStatus,
  threadId: Schema.NullOr(ThreadId),
  prBody: Schema.NullOr(Schema.String),
  prLabels: Schema.String, // JSON string in DB
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ReviewRequestRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const dbRowToReviewRequest = (row: typeof ReviewRequestDbRowSchema.Type): ReviewRequest => {
  let parsedLabels: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.prLabels);
    if (Array.isArray(parsed)) {
      parsedLabels = parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // Fallback to empty array on invalid JSON
  }

  return {
    id: row.id,
    prUrl: row.prUrl,
    prNumber: row.prNumber,
    prTitle: row.prTitle,
    repoNameWithOwner: row.repoNameWithOwner,
    authorLogin: row.authorLogin,
    isBot: row.isBot !== 0,
    status: row.status,
    ...(row.threadId !== null ? { threadId: row.threadId } : {}),
    ...(row.prBody !== null ? { prBody: row.prBody } : {}),
    ...(parsedLabels.length > 0 ? { prLabels: parsedLabels } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};

const makeReviewRequestRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const InsertRequestSchema = Schema.Struct({
    id: TrimmedNonEmptyString,
    prUrl: Schema.String,
    prNumber: PositiveInt,
    prTitle: TrimmedNonEmptyString,
    repoNameWithOwner: TrimmedNonEmptyString,
    authorLogin: TrimmedNonEmptyString,
    isBot: Schema.Number,
    status: ReviewRequestStatus,
    prBody: Schema.NullOr(Schema.String),
    prLabels: Schema.String,
    createdAt: Schema.String,
    updatedAt: Schema.String,
  });

  const insertOrReplaceRow = SqlSchema.void({
    Request: InsertRequestSchema,
    execute: (row) =>
      sql`
        INSERT INTO review_requests (
          id,
          pr_url,
          pr_number,
          pr_title,
          repo_name_with_owner,
          author_login,
          is_bot,
          status,
          pr_body,
          pr_labels,
          created_at,
          updated_at
        )
        VALUES (
          ${row.id},
          ${row.prUrl},
          ${row.prNumber},
          ${row.prTitle},
          ${row.repoNameWithOwner},
          ${row.authorLogin},
          ${row.isBot},
          ${row.status},
          ${row.prBody},
          ${row.prLabels},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT(pr_url) DO UPDATE SET
          pr_number = ${row.prNumber},
          pr_title = ${row.prTitle},
          author_login = ${row.authorLogin},
          is_bot = ${row.isBot},
          status = CASE WHEN review_requests.status = 'dismissed' THEN 'pending' ELSE review_requests.status END,
          pr_body = ${row.prBody},
          pr_labels = ${row.prLabels},
          updated_at = ${row.updatedAt}
      `,
  });

  const UpdateStatusRequestSchema = Schema.Struct({
    id: TrimmedNonEmptyString,
    status: ReviewRequestStatus,
    threadId: Schema.NullOr(Schema.String),
    updatedAt: Schema.String,
  });

  const updateStatusRow = SqlSchema.void({
    Request: UpdateStatusRequestSchema,
    execute: (input) =>
      sql`
        UPDATE review_requests
        SET
          status = ${input.status},
          thread_id = COALESCE(${input.threadId}, thread_id),
          updated_at = ${input.updatedAt}
        WHERE id = ${input.id}
      `,
  });

  const listActiveRows = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: ReviewRequestDbRowSchema,
    execute: () =>
      sql`
        SELECT
          id,
          pr_url AS "prUrl",
          pr_number AS "prNumber",
          pr_title AS "prTitle",
          repo_name_with_owner AS "repoNameWithOwner",
          author_login AS "authorLogin",
          is_bot AS "isBot",
          status,
          thread_id AS "threadId",
          pr_body AS "prBody",
          pr_labels AS "prLabels",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM review_requests
        WHERE status != 'dismissed'
        ORDER BY updated_at DESC
      `,
  });

  const findByPrUrl = SqlSchema.findAll({
    Request: Schema.Struct({ prUrl: Schema.String }),
    Result: ReviewRequestDbRowSchema,
    execute: ({ prUrl }) =>
      sql`
        SELECT
          id,
          pr_url AS "prUrl",
          pr_number AS "prNumber",
          pr_title AS "prTitle",
          repo_name_with_owner AS "repoNameWithOwner",
          author_login AS "authorLogin",
          is_bot AS "isBot",
          status,
          thread_id AS "threadId",
          pr_body AS "prBody",
          pr_labels AS "prLabels",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM review_requests
        WHERE pr_url = ${prUrl}
        LIMIT 1
      `,
  });

  const upsert: ReviewRequestRepositoryShape["upsert"] = (input) => {
    const now = new Date().toISOString();
    const id = crypto.randomUUID() as typeof TrimmedNonEmptyString.Type;

    const row = {
      id,
      prUrl: input.prUrl,
      prNumber: input.prNumber as typeof PositiveInt.Type,
      prTitle: input.prTitle as typeof TrimmedNonEmptyString.Type,
      repoNameWithOwner: input.repoNameWithOwner as typeof TrimmedNonEmptyString.Type,
      authorLogin: input.authorLogin as typeof TrimmedNonEmptyString.Type,
      isBot: input.isBot ? 1 : 0,
      status: "pending" as typeof ReviewRequestStatus.Type,
      prBody: input.prBody ?? null,
      prLabels: JSON.stringify(input.prLabels ?? []),
      createdAt: now,
      updatedAt: now,
    };

    return insertOrReplaceRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ReviewRequestRepository.upsert:query",
          "ReviewRequestRepository.upsert:encodeRequest",
        ),
      ),
      Effect.flatMap(() =>
        findByPrUrl({ prUrl: input.prUrl }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ReviewRequestRepository.upsert:findBack",
              "ReviewRequestRepository.upsert:decodeFindBack",
            ),
          ),
          Effect.map((rows) => dbRowToReviewRequest(rows[0]!)),
        ),
      ),
    );
  };

  const updateStatus: ReviewRequestRepositoryShape["updateStatus"] = (input) =>
    updateStatusRow({
      id: input.id as typeof TrimmedNonEmptyString.Type,
      status: input.status,
      threadId: input.threadId ?? null,
      updatedAt: new Date().toISOString(),
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ReviewRequestRepository.updateStatus:query",
          "ReviewRequestRepository.updateStatus:encodeRequest",
        ),
      ),
    );

  const listActive: ReviewRequestRepositoryShape["listActive"] = () =>
    listActiveRows({}).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ReviewRequestRepository.listActive:query",
          "ReviewRequestRepository.listActive:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(dbRowToReviewRequest)),
    );

  const dismissStale: ReviewRequestRepositoryShape["dismissStale"] = (activeUrls) => {
    if (activeUrls.length === 0) {
      // No active URLs means dismiss all non-dismissed requests (PRs closed/merged)
      return sql`
        UPDATE review_requests
        SET status = 'dismissed', updated_at = ${new Date().toISOString()}
        WHERE status != 'dismissed'
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ReviewRequestRepository.dismissStale:query")),
        Effect.asVoid,
      );
    }

    const now = new Date().toISOString();
    // Dismiss any request no longer in GitHub results (PR merged/closed/review removed)
    return sql`
      UPDATE review_requests
      SET status = 'dismissed', updated_at = ${now}
      WHERE status != 'dismissed'
        AND pr_url NOT IN ${sql.in(activeUrls)}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ReviewRequestRepository.dismissStale:query")),
      Effect.asVoid,
    );
  };

  return {
    upsert,
    updateStatus,
    listActive,
    dismissStale,
  } satisfies ReviewRequestRepositoryShape;
});

export const ReviewRequestRepositoryLive = Layer.effect(
  ReviewRequestRepository,
  makeReviewRequestRepository,
);
