/**
 * Durable storage for GitHub-backed thread waitpoints.
 *
 * A waitpoint is keyed by the originating dynamic-tool call. Registration is
 * therefore idempotent even if Codex retries the same request after a transport
 * interruption.
 */
import { IsoDateTime, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type GitHubWaitpointRepositoryError,
} from "./Errors.ts";
export type { GitHubWaitpointRepositoryError } from "./Errors.ts";

export const GitHubWaitpointCondition = Schema.Literals([
  "checks_settled",
  "new_review_activity",
  "pull_request_closed",
]);
export type GitHubWaitpointCondition = typeof GitHubWaitpointCondition.Type;

export const GitHubWaitpointState = Schema.Literals([
  "pending",
  "delivering",
  "delivered",
  "expired",
]);
export type GitHubWaitpointState = typeof GitHubWaitpointState.Type;

export const GitHubWaitpoint = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  originatingTurnId: Schema.String,
  repository: Schema.String,
  pullRequestNumber: Schema.Int,
  condition: GitHubWaitpointCondition,
  baseline: Schema.Unknown,
  continuationPrompt: Schema.String,
  state: GitHubWaitpointState,
  nextPollAt: IsoDateTime,
  deadlineAt: IsoDateTime,
  deliveryLeaseExpiresAt: Schema.NullOr(IsoDateTime),
  attemptCount: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deliveredAt: Schema.NullOr(IsoDateTime),
});
export type GitHubWaitpoint = typeof GitHubWaitpoint.Type;

export const RegisterGitHubWaitpointInput = Schema.Struct({
  id: GitHubWaitpoint.fields.id,
  threadId: GitHubWaitpoint.fields.threadId,
  originatingTurnId: GitHubWaitpoint.fields.originatingTurnId,
  repository: GitHubWaitpoint.fields.repository,
  pullRequestNumber: GitHubWaitpoint.fields.pullRequestNumber,
  condition: GitHubWaitpoint.fields.condition,
  baseline: GitHubWaitpoint.fields.baseline,
  continuationPrompt: GitHubWaitpoint.fields.continuationPrompt,
  nextPollAt: GitHubWaitpoint.fields.nextPollAt,
  deadlineAt: GitHubWaitpoint.fields.deadlineAt,
  createdAt: GitHubWaitpoint.fields.createdAt,
});
export type RegisterGitHubWaitpointInput = typeof RegisterGitHubWaitpointInput.Type;

const GetGitHubWaitpointInput = Schema.Struct({ id: Schema.String });
export type GetGitHubWaitpointInput = typeof GetGitHubWaitpointInput.Type;
const ListDueGitHubWaitpointsInput = Schema.Struct({
  now: IsoDateTime,
  limit: Schema.Int.check(Schema.isGreaterThan(0)),
});
const ClaimGitHubWaitpointInput = Schema.Struct({
  id: Schema.String,
  now: IsoDateTime,
  leaseExpiresAt: IsoDateTime,
});
const MarkGitHubWaitpointDeliveredInput = Schema.Struct({
  id: Schema.String,
  deliveredAt: IsoDateTime,
});
const RescheduleGitHubWaitpointInput = Schema.Struct({
  id: Schema.String,
  nextPollAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.NullOr(Schema.String),
});
const MarkGitHubWaitpointExpiredInput = Schema.Struct({
  id: Schema.String,
  expiredAt: IsoDateTime,
  lastError: Schema.String,
});

export class GitHubWaitpointRepository extends Context.Service<
  GitHubWaitpointRepository,
  {
    readonly register: (
      input: RegisterGitHubWaitpointInput,
    ) => Effect.Effect<void, GitHubWaitpointRepositoryError>;
    readonly getById: (
      input: GetGitHubWaitpointInput,
    ) => Effect.Effect<Option.Option<GitHubWaitpoint>, GitHubWaitpointRepositoryError>;
    readonly listDue: (
      input: typeof ListDueGitHubWaitpointsInput.Type,
    ) => Effect.Effect<ReadonlyArray<GitHubWaitpoint>, GitHubWaitpointRepositoryError>;
    readonly claim: (
      input: typeof ClaimGitHubWaitpointInput.Type,
    ) => Effect.Effect<Option.Option<GitHubWaitpoint>, GitHubWaitpointRepositoryError>;
    readonly markDelivered: (
      input: typeof MarkGitHubWaitpointDeliveredInput.Type,
    ) => Effect.Effect<void, GitHubWaitpointRepositoryError>;
    readonly reschedule: (
      input: typeof RescheduleGitHubWaitpointInput.Type,
    ) => Effect.Effect<void, GitHubWaitpointRepositoryError>;
    readonly markExpired: (
      input: typeof MarkGitHubWaitpointExpiredInput.Type,
    ) => Effect.Effect<void, GitHubWaitpointRepositoryError>;
  }
>()("t3/persistence/GitHubWaitpoints/GitHubWaitpointRepository") {}

const GitHubWaitpointDbRow = GitHubWaitpoint.mapFields(
  Struct.assign({ baseline: Schema.fromJsonString(Schema.Unknown) }),
);
const GitHubWaitpointRawDbRow = Schema.Struct({
  id: Schema.Unknown,
  threadId: Schema.Unknown,
  originatingTurnId: Schema.Unknown,
  repository: Schema.Unknown,
  pullRequestNumber: Schema.Unknown,
  condition: Schema.Unknown,
  baseline: Schema.Unknown,
  continuationPrompt: Schema.Unknown,
  state: Schema.Unknown,
  nextPollAt: Schema.Unknown,
  deadlineAt: Schema.Unknown,
  deliveryLeaseExpiresAt: Schema.Unknown,
  attemptCount: Schema.Unknown,
  lastError: Schema.Unknown,
  createdAt: Schema.Unknown,
  updatedAt: Schema.Unknown,
  deliveredAt: Schema.Unknown,
});
const RegisterGitHubWaitpointDbInput = RegisterGitHubWaitpointInput.mapFields(
  Struct.assign({ baseline: Schema.fromJsonString(Schema.Unknown) }),
);

function mapRepositoryError(operation: string, threadId?: ThreadId) {
  return (cause: unknown): GitHubWaitpointRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(
          `${operation}:decode`,
          cause,
          threadId === undefined ? undefined : { threadId },
        )
      : new PersistenceSqlError({
          operation: `${operation}:query`,
          ...(threadId === undefined ? {} : { correlation: { threadId } }),
          cause,
        });
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertWaitpoint = SqlSchema.void({
    Request: RegisterGitHubWaitpointDbInput,
    execute: (input) => sql`
      INSERT INTO github_waitpoints (
        id,
        thread_id,
        originating_turn_id,
        repository,
        pull_request_number,
        condition,
        baseline_json,
        continuation_prompt,
        state,
        next_poll_at,
        deadline_at,
        delivery_lease_expires_at,
        attempt_count,
        last_error,
        created_at,
        updated_at,
        delivered_at
      )
      VALUES (
        ${input.id},
        ${input.threadId},
        ${input.originatingTurnId},
        ${input.repository},
        ${input.pullRequestNumber},
        ${input.condition},
        ${input.baseline},
        ${input.continuationPrompt},
        'pending',
        ${input.nextPollAt},
        ${input.deadlineAt},
        NULL,
        0,
        NULL,
        ${input.createdAt},
        ${input.createdAt},
        NULL
      )
      ON CONFLICT (id) DO NOTHING
    `,
  });

  const selectWaitpoint = SqlSchema.findOneOption({
    Request: GetGitHubWaitpointInput,
    Result: GitHubWaitpointRawDbRow,
    execute: ({ id }) => sql`
      SELECT
        id,
        thread_id AS "threadId",
        originating_turn_id AS "originatingTurnId",
        repository,
        pull_request_number AS "pullRequestNumber",
        condition,
        baseline_json AS baseline,
        continuation_prompt AS "continuationPrompt",
        state,
        next_poll_at AS "nextPollAt",
        deadline_at AS "deadlineAt",
        delivery_lease_expires_at AS "deliveryLeaseExpiresAt",
        attempt_count AS "attemptCount",
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        delivered_at AS "deliveredAt"
      FROM github_waitpoints
      WHERE id = ${id}
    `,
  });

  const listDueWaitpoints = SqlSchema.findAll({
    Request: ListDueGitHubWaitpointsInput,
    Result: GitHubWaitpointRawDbRow,
    execute: ({ now, limit }) => sql`
      SELECT
        id,
        thread_id AS "threadId",
        originating_turn_id AS "originatingTurnId",
        repository,
        pull_request_number AS "pullRequestNumber",
        condition,
        baseline_json AS baseline,
        continuation_prompt AS "continuationPrompt",
        state,
        next_poll_at AS "nextPollAt",
        deadline_at AS "deadlineAt",
        delivery_lease_expires_at AS "deliveryLeaseExpiresAt",
        attempt_count AS "attemptCount",
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        delivered_at AS "deliveredAt"
      FROM github_waitpoints
      WHERE (state = 'pending' AND next_poll_at <= ${now})
         OR (state = 'delivering' AND delivery_lease_expires_at <= ${now})
      ORDER BY next_poll_at ASC, created_at ASC, id ASC
      LIMIT ${limit}
    `,
  });

  const claimWaitpoint = SqlSchema.findOneOption({
    Request: ClaimGitHubWaitpointInput,
    Result: GitHubWaitpointRawDbRow,
    execute: ({ id, now, leaseExpiresAt }) => sql`
      UPDATE github_waitpoints
      SET
        state = 'delivering',
        delivery_lease_expires_at = ${leaseExpiresAt},
        attempt_count = attempt_count + 1,
        updated_at = ${now}
      WHERE id = ${id}
        AND (
          (state = 'pending' AND next_poll_at <= ${now})
          OR (state = 'delivering' AND delivery_lease_expires_at <= ${now})
        )
      RETURNING
        id,
        thread_id AS "threadId",
        originating_turn_id AS "originatingTurnId",
        repository,
        pull_request_number AS "pullRequestNumber",
        condition,
        baseline_json AS baseline,
        continuation_prompt AS "continuationPrompt",
        state,
        next_poll_at AS "nextPollAt",
        deadline_at AS "deadlineAt",
        delivery_lease_expires_at AS "deliveryLeaseExpiresAt",
        attempt_count AS "attemptCount",
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        delivered_at AS "deliveredAt"
    `,
  });

  const markWaitpointDelivered = SqlSchema.void({
    Request: MarkGitHubWaitpointDeliveredInput,
    execute: ({ id, deliveredAt }) => sql`
      UPDATE github_waitpoints
      SET
        state = 'delivered',
        delivery_lease_expires_at = NULL,
        last_error = NULL,
        delivered_at = ${deliveredAt},
        updated_at = ${deliveredAt}
      WHERE id = ${id} AND state = 'delivering'
    `,
  });

  const rescheduleWaitpoint = SqlSchema.void({
    Request: RescheduleGitHubWaitpointInput,
    execute: ({ id, nextPollAt, updatedAt, lastError }) => sql`
      UPDATE github_waitpoints
      SET
        state = 'pending',
        next_poll_at = ${nextPollAt},
        delivery_lease_expires_at = NULL,
        last_error = ${lastError},
        updated_at = ${updatedAt}
      WHERE id = ${id} AND state IN ('pending', 'delivering')
    `,
  });

  const expireWaitpoint = SqlSchema.void({
    Request: MarkGitHubWaitpointExpiredInput,
    execute: ({ id, expiredAt, lastError }) => sql`
      UPDATE github_waitpoints
      SET
        state = 'expired',
        delivery_lease_expires_at = NULL,
        last_error = ${lastError},
        updated_at = ${expiredAt}
      WHERE id = ${id} AND state IN ('pending', 'delivering')
    `,
  });

  const decodeWaitpoint = Schema.decodeUnknownEffect(GitHubWaitpointDbRow);
  const decodeOptionalWaitpoint = Option.match({
    onNone: () => Effect.succeed(Option.none<GitHubWaitpoint>()),
    onSome: (row: typeof GitHubWaitpointRawDbRow.Type) =>
      decodeWaitpoint(row).pipe(Effect.map(Option.some)),
  });

  return GitHubWaitpointRepository.of({
    register: (input) =>
      insertWaitpoint(input).pipe(
        Effect.mapError(mapRepositoryError("GitHubWaitpointRepository.register", input.threadId)),
      ),
    getById: (input) =>
      selectWaitpoint(input).pipe(
        Effect.mapError(mapRepositoryError("GitHubWaitpointRepository.getById")),
        Effect.flatMap(decodeOptionalWaitpoint),
        Effect.mapError(mapRepositoryError("GitHubWaitpointRepository.getById")),
      ),
    listDue: (input) =>
      listDueWaitpoints(input).pipe(
        Effect.mapError(mapRepositoryError("GitHubWaitpointRepository.listDue")),
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeWaitpoint(row))),
        Effect.mapError(mapRepositoryError("GitHubWaitpointRepository.listDue")),
      ),
    claim: (input) =>
      claimWaitpoint(input).pipe(
        Effect.mapError(mapRepositoryError("GitHubWaitpointRepository.claim")),
        Effect.flatMap(decodeOptionalWaitpoint),
        Effect.mapError(mapRepositoryError("GitHubWaitpointRepository.claim")),
      ),
    markDelivered: (input) =>
      markWaitpointDelivered(input).pipe(
        Effect.mapError(mapRepositoryError("GitHubWaitpointRepository.markDelivered")),
      ),
    reschedule: (input) =>
      rescheduleWaitpoint(input).pipe(
        Effect.mapError(mapRepositoryError("GitHubWaitpointRepository.reschedule")),
      ),
    markExpired: (input) =>
      expireWaitpoint(input).pipe(
        Effect.mapError(mapRepositoryError("GitHubWaitpointRepository.markExpired")),
      ),
  });
});

export const layer = Layer.effect(GitHubWaitpointRepository, make);
