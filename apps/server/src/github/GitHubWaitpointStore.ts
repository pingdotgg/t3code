import {
  GitHubWaitpointId,
  IsoDateTime,
  NonNegativeInt,
  OrchestratorMcpGitHubWaitCondition,
  OrchestratorMcpGitHubWaitState,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { GitHubPullRequestSnapshot } from "./GitHubPullRequestProbe.ts";

export const GitHubWaitpoint = Schema.Struct({
  id: GitHubWaitpointId,
  projectId: ProjectId,
  threadId: ThreadId,
  originatingRunId: RunId,
  repository: Schema.String,
  pullRequestNumber: Schema.Int,
  condition: OrchestratorMcpGitHubWaitCondition,
  baseline: GitHubPullRequestSnapshot,
  continuationPrompt: Schema.String,
  deliveryPrompt: Schema.NullOr(Schema.String),
  state: OrchestratorMcpGitHubWaitState,
  nextPollAt: IsoDateTime,
  deadlineAt: IsoDateTime,
  deliveryLeaseToken: Schema.NullOr(Schema.String),
  deliveryLeaseExpiresAt: Schema.NullOr(IsoDateTime),
  attemptCount: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type GitHubWaitpoint = typeof GitHubWaitpoint.Type;

export interface RegisterGitHubWaitpointInput {
  readonly id: GitHubWaitpointId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly originatingRunId: RunId;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly condition: OrchestratorMcpGitHubWaitCondition;
  readonly baseline: GitHubPullRequestSnapshot;
  readonly continuationPrompt: string;
  readonly nextPollAt: string;
  readonly deadlineAt: string;
  readonly createdAt: string;
}

export class GitHubWaitpointStoreError extends Schema.TaggedErrorClass<GitHubWaitpointStoreError>()(
  "GitHubWaitpointStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `GitHub waitpoint persistence failed during ${this.operation}.`;
  }
}

interface GitHubWaitpointRow {
  readonly waitpoint_id: unknown;
  readonly project_id: unknown;
  readonly thread_id: unknown;
  readonly originating_run_id: unknown;
  readonly repository: unknown;
  readonly pull_request_number: unknown;
  readonly condition: unknown;
  readonly baseline_json: unknown;
  readonly continuation_prompt: unknown;
  readonly delivery_prompt: unknown;
  readonly state: unknown;
  readonly next_poll_at: unknown;
  readonly deadline_at: unknown;
  readonly delivery_lease_token: unknown;
  readonly delivery_lease_expires_at: unknown;
  readonly attempt_count: unknown;
  readonly last_error: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly completed_at: unknown;
}

const decodeBaseline = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubPullRequestSnapshot));
const encodeBaseline = Schema.encodeEffect(Schema.fromJsonString(GitHubPullRequestSnapshot));
const decodeWaitpoint = Schema.decodeUnknownEffect(GitHubWaitpoint);

function storeError(operation: string) {
  return (cause: unknown) => new GitHubWaitpointStoreError({ operation, cause });
}

const decodeRow = Effect.fn("GitHubWaitpointStore.decodeRow")(function* (row: GitHubWaitpointRow) {
  const baseline = yield* decodeBaseline(row.baseline_json);
  return yield* decodeWaitpoint({
    id: row.waitpoint_id,
    projectId: row.project_id,
    threadId: row.thread_id,
    originatingRunId: row.originating_run_id,
    repository: row.repository,
    pullRequestNumber: row.pull_request_number,
    condition: row.condition,
    baseline,
    continuationPrompt: row.continuation_prompt,
    deliveryPrompt: row.delivery_prompt,
    state: row.state,
    nextPollAt: row.next_poll_at,
    deadlineAt: row.deadline_at,
    deliveryLeaseToken: row.delivery_lease_token,
    deliveryLeaseExpiresAt: row.delivery_lease_expires_at,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  });
});

const columns = `
  waitpoint_id,
  project_id,
  thread_id,
  originating_run_id,
  repository,
  pull_request_number,
  condition,
  baseline_json,
  continuation_prompt,
  delivery_prompt,
  state,
  next_poll_at,
  deadline_at,
  delivery_lease_token,
  delivery_lease_expires_at,
  attempt_count,
  last_error,
  created_at,
  updated_at,
  completed_at
` as const;

export interface GitHubWaitpointStoreShape {
  readonly register: (
    input: RegisterGitHubWaitpointInput,
  ) => Effect.Effect<GitHubWaitpoint, GitHubWaitpointStoreError>;
  readonly get: (
    id: GitHubWaitpointId,
  ) => Effect.Effect<Option.Option<GitHubWaitpoint>, GitHubWaitpointStoreError>;
  readonly listForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<GitHubWaitpoint>, GitHubWaitpointStoreError>;
  readonly listDue: (input: {
    readonly now: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<GitHubWaitpoint>, GitHubWaitpointStoreError>;
  readonly claim: (input: {
    readonly id: GitHubWaitpointId;
    readonly now: string;
    readonly leaseToken: string;
    readonly leaseExpiresAt: string;
    readonly deliveryPrompt: string;
  }) => Effect.Effect<Option.Option<GitHubWaitpoint>, GitHubWaitpointStoreError>;
  readonly reschedulePending: (input: {
    readonly id: GitHubWaitpointId;
    readonly nextPollAt: string;
    readonly updatedAt: string;
    readonly lastError: string | null;
  }) => Effect.Effect<boolean, GitHubWaitpointStoreError>;
  readonly expirePending: (input: {
    readonly id: GitHubWaitpointId;
    readonly completedAt: string;
    readonly lastError: string;
  }) => Effect.Effect<boolean, GitHubWaitpointStoreError>;
  readonly rescheduleClaim: (input: {
    readonly id: GitHubWaitpointId;
    readonly leaseToken: string;
    readonly nextPollAt: string;
    readonly updatedAt: string;
    readonly lastError: string | null;
  }) => Effect.Effect<boolean, GitHubWaitpointStoreError>;
  readonly expireClaim: (input: {
    readonly id: GitHubWaitpointId;
    readonly leaseToken: string;
    readonly completedAt: string;
    readonly lastError: string;
  }) => Effect.Effect<boolean, GitHubWaitpointStoreError>;
  readonly markDelivered: (input: {
    readonly id: GitHubWaitpointId;
    readonly leaseToken: string;
    readonly completedAt: string;
  }) => Effect.Effect<boolean, GitHubWaitpointStoreError>;
  readonly cancel: (input: {
    readonly id: GitHubWaitpointId;
    readonly threadId: ThreadId;
    readonly completedAt: string;
  }) => Effect.Effect<Option.Option<GitHubWaitpoint>, GitHubWaitpointStoreError>;
}

export class GitHubWaitpointStore extends Context.Service<
  GitHubWaitpointStore,
  GitHubWaitpointStoreShape
>()("t3/github/GitHubWaitpointStore") {}

export const layer = Layer.effect(
  GitHubWaitpointStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const get = Effect.fn("GitHubWaitpointStore.get")(
      function* (id: GitHubWaitpointId) {
        const rows = yield* sql<GitHubWaitpointRow>`
        SELECT ${sql.unsafe(columns)}
        FROM github_waitpoints
        WHERE waitpoint_id = ${id}
      `;
        const row = rows[0];
        return row === undefined
          ? Option.none<GitHubWaitpoint>()
          : Option.some(yield* decodeRow(row));
      },
      Effect.mapError(storeError("get")),
    );

    const decodeRows = (rows: ReadonlyArray<GitHubWaitpointRow>) =>
      Effect.forEach(rows, decodeRow, { concurrency: 1 });

    const changed = (rows: ReadonlyArray<unknown>) => rows.length > 0;

    return GitHubWaitpointStore.of({
      register: Effect.fn("GitHubWaitpointStore.register")(
        function* (input) {
          const baseline = yield* encodeBaseline(input.baseline);
          yield* sql`
            INSERT INTO github_waitpoints (
              waitpoint_id,
              project_id,
              thread_id,
              originating_run_id,
              repository,
              pull_request_number,
              condition,
              baseline_json,
              continuation_prompt,
              delivery_prompt,
              state,
              next_poll_at,
              deadline_at,
              delivery_lease_token,
              delivery_lease_expires_at,
              attempt_count,
              last_error,
              created_at,
              updated_at,
              completed_at
            ) VALUES (
              ${input.id},
              ${input.projectId},
              ${input.threadId},
              ${input.originatingRunId},
              ${input.repository},
              ${input.pullRequestNumber},
              ${input.condition},
              ${baseline},
              ${input.continuationPrompt},
              NULL,
              'pending',
              ${input.nextPollAt},
              ${input.deadlineAt},
              NULL,
              NULL,
              0,
              NULL,
              ${input.createdAt},
              ${input.createdAt},
              NULL
            )
            ON CONFLICT (waitpoint_id) DO NOTHING
          `;
          const stored = yield* get(input.id);
          if (Option.isNone(stored)) {
            return yield* new GitHubWaitpointStoreError({
              operation: "register:reload",
              cause: "Inserted waitpoint could not be reloaded.",
            });
          }
          return stored.value;
        },
        Effect.mapError(storeError("register")),
      ),
      get,
      listForThread: Effect.fn("GitHubWaitpointStore.listForThread")(
        function* (threadId) {
          const rows = yield* sql<GitHubWaitpointRow>`
            SELECT ${sql.unsafe(columns)}
            FROM github_waitpoints
            WHERE thread_id = ${threadId}
            ORDER BY created_at DESC, waitpoint_id ASC
          `;
          return yield* decodeRows(rows);
        },
        Effect.mapError(storeError("listForThread")),
      ),
      listDue: Effect.fn("GitHubWaitpointStore.listDue")(
        function* ({ now, limit }) {
          const rows = yield* sql<GitHubWaitpointRow>`
            SELECT ${sql.unsafe(columns)}
            FROM github_waitpoints
            WHERE (state = 'pending' AND next_poll_at <= ${now})
               OR (
                 state = 'delivering'
                 AND delivery_lease_expires_at IS NOT NULL
                 AND delivery_lease_expires_at <= ${now}
               )
            ORDER BY next_poll_at ASC, created_at ASC, waitpoint_id ASC
            LIMIT ${limit}
          `;
          return yield* decodeRows(rows);
        },
        Effect.mapError(storeError("listDue")),
      ),
      claim: Effect.fn("GitHubWaitpointStore.claim")(
        function* ({ id, now, leaseToken, leaseExpiresAt, deliveryPrompt }) {
          const rows = yield* sql<GitHubWaitpointRow>`
            UPDATE github_waitpoints
            SET
              state = 'delivering',
              delivery_lease_token = ${leaseToken},
              delivery_lease_expires_at = ${leaseExpiresAt},
              delivery_prompt = COALESCE(delivery_prompt, ${deliveryPrompt}),
              attempt_count = attempt_count + 1,
              updated_at = ${now}
            WHERE waitpoint_id = ${id}
              AND (
                (state = 'pending' AND next_poll_at <= ${now})
                OR (
                  state = 'delivering'
                  AND delivery_lease_expires_at IS NOT NULL
                  AND delivery_lease_expires_at <= ${now}
                )
              )
            RETURNING ${sql.unsafe(columns)}
          `;
          const row = rows[0];
          return row === undefined
            ? Option.none<GitHubWaitpoint>()
            : Option.some(yield* decodeRow(row));
        },
        Effect.mapError(storeError("claim")),
      ),
      reschedulePending: Effect.fn("GitHubWaitpointStore.reschedulePending")(
        function* ({ id, nextPollAt, updatedAt, lastError }) {
          const rows = yield* sql`
            UPDATE github_waitpoints
            SET
              next_poll_at = ${nextPollAt},
              last_error = ${lastError},
              updated_at = ${updatedAt}
            WHERE waitpoint_id = ${id} AND state = 'pending'
            RETURNING waitpoint_id
          `;
          return changed(rows);
        },
        Effect.mapError(storeError("reschedulePending")),
      ),
      expirePending: Effect.fn("GitHubWaitpointStore.expirePending")(
        function* ({ id, completedAt, lastError }) {
          const rows = yield* sql`
            UPDATE github_waitpoints
            SET
              state = 'expired',
              last_error = ${lastError},
              updated_at = ${completedAt},
              completed_at = ${completedAt}
            WHERE waitpoint_id = ${id} AND state = 'pending'
            RETURNING waitpoint_id
          `;
          return changed(rows);
        },
        Effect.mapError(storeError("expirePending")),
      ),
      rescheduleClaim: Effect.fn("GitHubWaitpointStore.rescheduleClaim")(
        function* ({ id, leaseToken, nextPollAt, updatedAt, lastError }) {
          const rows = yield* sql`
            UPDATE github_waitpoints
            SET
              state = 'pending',
              next_poll_at = ${nextPollAt},
              delivery_lease_token = NULL,
              delivery_lease_expires_at = NULL,
              last_error = ${lastError},
              updated_at = ${updatedAt}
            WHERE waitpoint_id = ${id}
              AND state = 'delivering'
              AND delivery_lease_token = ${leaseToken}
            RETURNING waitpoint_id
          `;
          return changed(rows);
        },
        Effect.mapError(storeError("rescheduleClaim")),
      ),
      expireClaim: Effect.fn("GitHubWaitpointStore.expireClaim")(
        function* ({ id, leaseToken, completedAt, lastError }) {
          const rows = yield* sql`
            UPDATE github_waitpoints
            SET
              state = 'expired',
              delivery_lease_token = NULL,
              delivery_lease_expires_at = NULL,
              last_error = ${lastError},
              updated_at = ${completedAt},
              completed_at = ${completedAt}
            WHERE waitpoint_id = ${id}
              AND state = 'delivering'
              AND delivery_lease_token = ${leaseToken}
            RETURNING waitpoint_id
          `;
          return changed(rows);
        },
        Effect.mapError(storeError("expireClaim")),
      ),
      markDelivered: Effect.fn("GitHubWaitpointStore.markDelivered")(
        function* ({ id, leaseToken, completedAt }) {
          const rows = yield* sql`
            UPDATE github_waitpoints
            SET
              state = 'delivered',
              delivery_lease_token = NULL,
              delivery_lease_expires_at = NULL,
              last_error = NULL,
              updated_at = ${completedAt},
              completed_at = ${completedAt}
            WHERE waitpoint_id = ${id}
              AND state = 'delivering'
              AND delivery_lease_token = ${leaseToken}
            RETURNING waitpoint_id
          `;
          return changed(rows);
        },
        Effect.mapError(storeError("markDelivered")),
      ),
      cancel: Effect.fn("GitHubWaitpointStore.cancel")(
        function* ({ id, threadId, completedAt }) {
          yield* sql`
            UPDATE github_waitpoints
            SET
              state = 'cancelled',
              last_error = NULL,
              updated_at = ${completedAt},
              completed_at = ${completedAt}
            WHERE waitpoint_id = ${id}
              AND thread_id = ${threadId}
              AND state = 'pending'
          `;
          const stored = yield* get(id);
          return Option.filter(stored, (waitpoint) => waitpoint.threadId === threadId);
        },
        Effect.mapError(storeError("cancel")),
      ),
    });
  }),
);
