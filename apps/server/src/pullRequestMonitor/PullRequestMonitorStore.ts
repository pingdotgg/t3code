import {
  PullRequestMonitorError,
  PullRequestMonitorId,
  type PullRequestMonitorActionableEvent,
  type PullRequestMonitorCanonicalKey,
  type PullRequestMonitorLifecycleStatus,
  type PullRequestMonitorReadiness,
  type PullRequestMonitorRecord,
  type PullRequestMonitorSnapshot,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  formatPullRequestMonitorCanonicalKey,
  normalizeRepositoryIdentity,
} from "./canonicalKey.ts";
import { emptyCursor, type PullRequestMonitorCursor } from "./monitorDiff.ts";
import { MAX_RETAINED_SNAPSHOTS } from "./pollSchedule.ts";

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// Bound for the dashboard-style list() scan; callers needing more pass limit explicitly.
const DEFAULT_LIST_LIMIT = 500;

const decodeCursor = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      headSha: Schema.String,
      state: Schema.String,
      reviewStates: Schema.Record(Schema.String, Schema.String),
      threadVersions: Schema.Record(
        Schema.String,
        Schema.Struct({
          updatedAt: Schema.String,
          resolved: Schema.Boolean,
        }),
      ),
      issueCommentVersions: Schema.Record(Schema.String, Schema.String),
      checkRuns: Schema.Record(
        Schema.String,
        Schema.Struct({
          runId: Schema.String,
          outcome: Schema.Literals(["success", "failure", "pending", "cancelled"]),
        }),
      ),
      mergeability: Schema.Literals(["mergeable", "conflicting", "unknown", ""]).pipe(
        Schema.withDecodingDefault(Effect.succeed("")),
      ),
      sourceRevision: Schema.String,
    }),
  ),
);

const decodeReadiness = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      ready: Schema.Boolean,
      label: Schema.Literals(["ready-to-merge", "no-known-blockers", "blocked"]),
      blockers: Schema.Array(
        Schema.Struct({
          kind: Schema.String,
          detail: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

const decodeSnapshotJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeEventsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

interface MonitorRow {
  readonly monitor_id: string;
  readonly canonical_key: string;
  readonly provider: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly project_id: string;
  readonly owner_thread_id: string | null;
  readonly linked_review_thread_id: string | null;
  readonly status: string;
  readonly enabled: number;
  readonly readiness_json: string | null;
  readonly head_sha: string | null;
  readonly source_revision: string | null;
  readonly cursor_json: string | null;
  readonly last_polled_at: string | null;
  readonly next_poll_at: string | null;
  readonly last_error: string | null;
  readonly poll_failure_count: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly stopped_at: string | null;
}

interface SnapshotRow {
  readonly snapshot_id: string;
  readonly monitor_id: string;
  readonly source_revision: string;
  readonly head_sha: string;
  readonly fetched_at: string;
  readonly snapshot_json: string;
  readonly readiness_json: string;
  readonly events_json: string;
}

const isPullRequestMonitorError = Schema.is(PullRequestMonitorError);

/**
 * Internal rollback signal: a fenced-out poll must undo everything it already wrote in
 * the commit transaction, and `withTransaction` only rolls back on failure.
 */
class PollLeaseFenced extends Data.TaggedError("PullRequestMonitorPollLeaseFenced")<
  Record<string, never>
> {}

/** Clock read inside the commit transaction; the caller's poll-start time is stale by then. */
const isoNow = Effect.map(DateTime.now, (now) => DateTime.formatIso(DateTime.toUtc(now)));

function storeError(message: string, cause?: unknown) {
  return new PullRequestMonitorError({ message, cause });
}

function rowToRecord(
  row: MonitorRow,
): Effect.Effect<PullRequestMonitorRecord, PullRequestMonitorError> {
  return Effect.gen(function* () {
    let readiness: PullRequestMonitorReadiness | null = null;
    if (row.readiness_json) {
      const decoded = yield* decodeReadiness(row.readiness_json).pipe(
        Effect.mapError((cause) => storeError("Could not decode monitor readiness.", cause)),
      );
      readiness = decoded as PullRequestMonitorReadiness;
    }
    return {
      id: PullRequestMonitorId.make(row.monitor_id),
      canonicalKey: row.canonical_key,
      provider: row.provider as PullRequestMonitorRecord["provider"],
      host: row.host,
      repository: row.repository,
      number: row.number,
      projectId: row.project_id as PullRequestMonitorRecord["projectId"],
      ownerThreadId: row.owner_thread_id as PullRequestMonitorRecord["ownerThreadId"],
      linkedReviewThreadId: (row.linked_review_thread_id ??
        null) as PullRequestMonitorRecord["linkedReviewThreadId"],
      status: row.status as PullRequestMonitorLifecycleStatus,
      enabled: row.enabled === 1,
      readiness,
      headSha: row.head_sha,
      sourceRevision: row.source_revision,
      lastPolledAt: row.last_polled_at,
      nextPollAt: row.next_poll_at,
      lastError: row.last_error,
      pollFailureCount: row.poll_failure_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      stoppedAt: row.stopped_at,
    } satisfies PullRequestMonitorRecord;
  });
}

export interface PullRequestMonitorPollLease {
  readonly canonicalKey: string;
  readonly ownerId: string;
  readonly generation: number;
  readonly expiresAt: string;
}

export interface PullRequestMonitorFallbackLaunchRecord {
  readonly launchId: string;
  readonly commandId: string;
  readonly threadId: string | null;
  readonly reason: string;
  readonly status: PullRequestMonitorFallbackLaunchStatus;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Fallback launch stages. Intent (`claimed`) is durable before any worktree or thread
 * side effect, so a crash can always be reconciled back to a terminal stage.
 */
export type PullRequestMonitorFallbackLaunchStatus =
  | "claimed"
  | "worktree-ready"
  | "thread-created"
  | "owned"
  | "launched"
  | "failed"
  | "abandoned";

export const FALLBACK_LAUNCH_TERMINAL_STATUSES: ReadonlySet<PullRequestMonitorFallbackLaunchStatus> =
  new Set(["launched", "failed", "abandoned"]);

export interface PullRequestMonitorStoreApi {
  readonly canonicalKey: (key: PullRequestMonitorCanonicalKey) => string;
  readonly getById: (
    id: PullRequestMonitorId,
  ) => Effect.Effect<PullRequestMonitorRecord | null, PullRequestMonitorError>;
  readonly getByCanonicalKey: (
    canonicalKey: string,
  ) => Effect.Effect<PullRequestMonitorRecord | null, PullRequestMonitorError>;
  readonly getByProjectRef: (input: {
    readonly projectId: string;
    readonly repository: string;
    readonly number: number;
  }) => Effect.Effect<PullRequestMonitorRecord | null, PullRequestMonitorError>;
  readonly list: (input: {
    readonly projectId?: string;
    readonly enabledOnly?: boolean;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<PullRequestMonitorRecord>, PullRequestMonitorError>;
  readonly listEnabledPage: (input: {
    readonly limit: number;
    readonly before?: {
      readonly updatedAt: string;
      readonly monitorId: PullRequestMonitorId;
    };
  }) => Effect.Effect<ReadonlyArray<PullRequestMonitorRecord>, PullRequestMonitorError>;
  readonly listDue: (
    nowIso: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<PullRequestMonitorRecord>, PullRequestMonitorError>;
  readonly insert: (
    record: PullRequestMonitorRecord,
    cursor: PullRequestMonitorCursor,
  ) => Effect.Effect<void, PullRequestMonitorError>;
  readonly update: (
    record: PullRequestMonitorRecord,
    cursor?: PullRequestMonitorCursor,
  ) => Effect.Effect<void, PullRequestMonitorError>;
  /**
   * Poll/lifecycle fields only — never rewrites ownership or review-link metadata,
   * so concurrent transfer/handoff cannot be clobbered by an in-flight poll.
   * Poll commits with `enabled: true` refuse to overwrite a concurrent stop unless
   * `allowReenable` is set (explicit start/resume). A `lease` fences the write to the
   * generation that observed the state, so a superseded poll can never commit.
   */
  readonly updatePollState: (
    record: PullRequestMonitorRecord,
    cursor?: PullRequestMonitorCursor,
    options?: {
      readonly allowReenable?: boolean;
      readonly lease?: PullRequestMonitorPollLease;
      readonly nowIso?: string;
    },
  ) => Effect.Effect<void, PullRequestMonitorError>;
  /** Narrow recheck schedule bump that cannot overwrite concurrent poll/ownership writes. */
  readonly scheduleRecheck: (input: {
    readonly monitorId: PullRequestMonitorId;
    readonly nextPollAt: string;
    readonly updatedAt: string;
  }) => Effect.Effect<void, PullRequestMonitorError>;
  readonly transferOwnershipAtomic: (input: {
    readonly monitorId: PullRequestMonitorId;
    readonly ownerThreadId: string | null;
    /** When set, CAS: only transfer if current owner still matches (null means still unset). */
    readonly expectedOwnerThreadId?: string | null;
    readonly linkedReviewThreadId?: string | null;
    readonly updatedAt: string;
    readonly eventId: string;
    readonly toThreadId: string | null;
    readonly reason: string;
  }) => Effect.Effect<boolean, PullRequestMonitorError>;
  readonly getCursor: (
    id: PullRequestMonitorId,
  ) => Effect.Effect<PullRequestMonitorCursor, PullRequestMonitorError>;
  readonly saveSnapshot: (input: {
    readonly snapshotId: string;
    readonly monitorId: PullRequestMonitorId;
    readonly snapshot: PullRequestMonitorSnapshot;
    readonly readiness: PullRequestMonitorReadiness;
    readonly events: ReadonlyArray<PullRequestMonitorActionableEvent>;
  }) => Effect.Effect<void, PullRequestMonitorError>;
  /**
   * One transaction for everything a poll observed: snapshot audit row, feedback
   * ingestion, and the poll state/cursor advance. Lease validity is judged by the clock
   * inside the transaction, never by the caller's poll-start time, because a slow
   * provider read can outlive the TTL it was granted. An expired or superseded
   * generation writes nothing at all — ingestion included — and reports `committed:
   * false`, meaning the cursor did not advance and the work will be retried.
   */
  readonly commitPollObservation: <Feedback>(input: {
    readonly lease: PullRequestMonitorPollLease;
    readonly cursor: PullRequestMonitorCursor;
    readonly snapshotId: string;
    readonly snapshot: PullRequestMonitorSnapshot;
    readonly events: ReadonlyArray<PullRequestMonitorActionableEvent>;
    /** Feedback reconciliation + ingestion, executed inside the same transaction. */
    readonly ingest: Effect.Effect<Feedback, PullRequestMonitorError>;
    /** Builds the committed record from post-ingest durable state and commit time. */
    readonly finalize: (
      feedback: Feedback,
      commitAt: string,
    ) => {
      readonly record: PullRequestMonitorRecord;
      readonly readiness: PullRequestMonitorReadiness;
    };
  }) => Effect.Effect<
    { readonly committed: boolean; readonly record: PullRequestMonitorRecord | null },
    PullRequestMonitorError
  >;
  readonly latestSnapshot: (monitorId: PullRequestMonitorId) => Effect.Effect<
    {
      readonly snapshot: PullRequestMonitorSnapshot;
      readonly events: ReadonlyArray<PullRequestMonitorActionableEvent>;
    } | null,
    PullRequestMonitorError
  >;
  /**
   * Claims one poll attempt. Every unexpired lease is rejected, including one held by
   * this process: the lease represents an attempt, not a renewable process lock. The
   * returned generation fences every write the attempt makes.
   */
  readonly tryAcquireLease: (input: {
    readonly canonicalKey: string;
    readonly ownerId: string;
    readonly nowIso: string;
    readonly expiresAt: string;
  }) => Effect.Effect<PullRequestMonitorPollLease | null, PullRequestMonitorError>;
  /** True while this exact generation still holds an unexpired lease. */
  readonly holdsLease: (
    lease: PullRequestMonitorPollLease,
    nowIso: string,
  ) => Effect.Effect<boolean, PullRequestMonitorError>;
  readonly releaseLease: (
    lease: PullRequestMonitorPollLease,
  ) => Effect.Effect<void, PullRequestMonitorError>;
  readonly getHostCooldownUntil: (
    hostKey: string,
    nowIso: string,
  ) => Effect.Effect<string | null, PullRequestMonitorError>;
  readonly setHostCooldown: (input: {
    readonly hostKey: string;
    readonly cooldownUntil: string;
    readonly reason: string;
    readonly nowIso: string;
  }) => Effect.Effect<void, PullRequestMonitorError>;
  readonly recordOwnershipEvent: (input: {
    readonly eventId: string;
    readonly monitorId: PullRequestMonitorId;
    readonly fromThreadId: string | null;
    readonly toThreadId: string | null;
    readonly reason: string;
    readonly createdAt: string;
  }) => Effect.Effect<void, PullRequestMonitorError>;
  readonly latestFallbackLaunch: (
    monitorId: PullRequestMonitorId,
  ) => Effect.Effect<PullRequestMonitorFallbackLaunchRecord | null, PullRequestMonitorError>;
  /** Non-terminal launches older than the cutoff, for crash recovery. */
  readonly listStaleFallbackLaunches: (input: {
    readonly olderThan: string;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<PullRequestMonitorFallbackLaunchRecord & { readonly monitorId: string }>,
    PullRequestMonitorError
  >;
  /** Durable launch intent; upsert so each stage transition is recorded on one row. */
  readonly recordFallbackLaunch: (input: {
    readonly launchId: string;
    readonly monitorId: PullRequestMonitorId;
    readonly commandId: string;
    readonly threadId: string | null;
    readonly reason: string;
    readonly status: PullRequestMonitorFallbackLaunchStatus;
    readonly error: string | null;
    readonly createdAt: string;
  }) => Effect.Effect<void, PullRequestMonitorError>;
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getById: PullRequestMonitorStoreApi["getById"] = (id) =>
    sql<MonitorRow>`
      SELECT * FROM pull_request_monitors WHERE monitor_id = ${id}
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(null) : rowToRecord(rows[0]),
      ),
      Effect.mapError((cause) =>
        isPullRequestMonitorError(cause) ? cause : storeError("Failed to load monitor.", cause),
      ),
    );

  const getByCanonicalKey: PullRequestMonitorStoreApi["getByCanonicalKey"] = (canonicalKey) =>
    sql<MonitorRow>`
      SELECT * FROM pull_request_monitors WHERE canonical_key = ${canonicalKey}
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(null) : rowToRecord(rows[0]),
      ),
      Effect.mapError((cause) =>
        isPullRequestMonitorError(cause)
          ? cause
          : storeError("Failed to load monitor by key.", cause),
      ),
    );

  const getByProjectRef: PullRequestMonitorStoreApi["getByProjectRef"] = (input) => {
    const repository = normalizeRepositoryIdentity(input.repository);
    return sql<MonitorRow>`
      SELECT * FROM pull_request_monitors
      WHERE project_id = ${input.projectId}
        AND lower(repository) = ${repository}
        AND number = ${input.number}
      ORDER BY updated_at DESC
      LIMIT 1
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(null) : rowToRecord(rows[0]),
      ),
      Effect.mapError((cause) =>
        isPullRequestMonitorError(cause)
          ? cause
          : storeError("Failed to load monitor by project ref.", cause),
      ),
    );
  };

  const list: PullRequestMonitorStoreApi["list"] = (input) =>
    Effect.gen(function* () {
      // Bound an otherwise full-table scan: monitor rows accumulate per project
      // and this feeds polling snapshot paths.
      const limit = input.limit ?? DEFAULT_LIST_LIMIT;
      const rows =
        input.projectId !== undefined && input.enabledOnly
          ? yield* sql<MonitorRow>`
              SELECT * FROM pull_request_monitors
              WHERE project_id = ${input.projectId} AND enabled = 1
              ORDER BY updated_at DESC
              LIMIT ${limit}
            `
          : input.projectId !== undefined
            ? yield* sql<MonitorRow>`
                SELECT * FROM pull_request_monitors
                WHERE project_id = ${input.projectId}
                ORDER BY updated_at DESC
                LIMIT ${limit}
              `
            : input.enabledOnly
              ? yield* sql<MonitorRow>`
                  SELECT * FROM pull_request_monitors
                  WHERE enabled = 1
                  ORDER BY updated_at DESC
                  LIMIT ${limit}
                `
              : yield* sql<MonitorRow>`
                  SELECT * FROM pull_request_monitors
                  ORDER BY updated_at DESC
                  LIMIT ${limit}
                `;
      return yield* Effect.forEach(rows, rowToRecord, { concurrency: 1 });
    }).pipe(
      Effect.mapError((cause) =>
        isPullRequestMonitorError(cause) ? cause : storeError("Failed to list monitors.", cause),
      ),
    );

  const listEnabledPage: PullRequestMonitorStoreApi["listEnabledPage"] = (input) =>
    (input.before
      ? sql<MonitorRow>`
            SELECT * FROM pull_request_monitors
            WHERE enabled = 1
              AND (
                updated_at < ${input.before.updatedAt}
                OR (
                  updated_at = ${input.before.updatedAt}
                  AND monitor_id < ${input.before.monitorId}
                )
              )
            ORDER BY updated_at DESC, monitor_id DESC
            LIMIT ${input.limit}
          `
      : sql<MonitorRow>`
            SELECT * FROM pull_request_monitors
            WHERE enabled = 1
            ORDER BY updated_at DESC, monitor_id DESC
            LIMIT ${input.limit}
          `
    ).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, rowToRecord, { concurrency: 1 })),
      Effect.mapError((cause) =>
        isPullRequestMonitorError(cause)
          ? cause
          : storeError("Failed to list enabled monitor page.", cause),
      ),
    );

  const listDue: PullRequestMonitorStoreApi["listDue"] = (nowIso, limit) =>
    sql<MonitorRow>`
      SELECT * FROM pull_request_monitors
      WHERE enabled = 1
        AND next_poll_at IS NOT NULL
        AND next_poll_at <= ${nowIso}
      ORDER BY next_poll_at ASC
      LIMIT ${limit}
    `.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, rowToRecord, { concurrency: 1 })),
      Effect.mapError((cause) =>
        isPullRequestMonitorError(cause)
          ? cause
          : storeError("Failed to list due monitors.", cause),
      ),
    );

  const insert: PullRequestMonitorStoreApi["insert"] = (record, cursor) =>
    sql`
      INSERT INTO pull_request_monitors (
        monitor_id, canonical_key, provider, host, repository, number, project_id,
        owner_thread_id, linked_review_thread_id, status, enabled, readiness_json, head_sha, source_revision,
        cursor_json, last_polled_at, next_poll_at, last_error, poll_failure_count,
        created_at, updated_at, stopped_at
      ) VALUES (
        ${record.id},
        ${record.canonicalKey},
        ${record.provider},
        ${record.host},
        ${record.repository},
        ${record.number},
        ${record.projectId},
        ${record.ownerThreadId},
        ${record.linkedReviewThreadId},
        ${record.status},
        ${record.enabled ? 1 : 0},
        ${record.readiness ? encodeUnknownJson(record.readiness) : null},
        ${record.headSha},
        ${record.sourceRevision},
        ${encodeUnknownJson(cursor)},
        ${record.lastPolledAt},
        ${record.nextPollAt},
        ${record.lastError},
        ${record.pollFailureCount},
        ${record.createdAt},
        ${record.updatedAt},
        ${record.stoppedAt}
      )
    `.pipe(
      Effect.mapError((cause) => storeError("Failed to insert monitor.", cause)),
      Effect.asVoid,
    );

  const update: PullRequestMonitorStoreApi["update"] = (record, cursor) =>
    (cursor
      ? sql`
          UPDATE pull_request_monitors SET
            owner_thread_id = ${record.ownerThreadId},
            linked_review_thread_id = ${record.linkedReviewThreadId},
            status = ${record.status},
            enabled = ${record.enabled ? 1 : 0},
            readiness_json = ${record.readiness ? encodeUnknownJson(record.readiness) : null},
            head_sha = ${record.headSha},
            source_revision = ${record.sourceRevision},
            cursor_json = ${encodeUnknownJson(cursor)},
            last_polled_at = ${record.lastPolledAt},
            next_poll_at = ${record.nextPollAt},
            last_error = ${record.lastError},
            poll_failure_count = ${record.pollFailureCount},
            updated_at = ${record.updatedAt},
            stopped_at = ${record.stoppedAt}
          WHERE monitor_id = ${record.id}
        `
      : sql`
          UPDATE pull_request_monitors SET
            owner_thread_id = ${record.ownerThreadId},
            linked_review_thread_id = ${record.linkedReviewThreadId},
            status = ${record.status},
            enabled = ${record.enabled ? 1 : 0},
            readiness_json = ${record.readiness ? encodeUnknownJson(record.readiness) : null},
            head_sha = ${record.headSha},
            source_revision = ${record.sourceRevision},
            last_polled_at = ${record.lastPolledAt},
            next_poll_at = ${record.nextPollAt},
            last_error = ${record.lastError},
            poll_failure_count = ${record.pollFailureCount},
            updated_at = ${record.updatedAt},
            stopped_at = ${record.stoppedAt}
          WHERE monitor_id = ${record.id}
        `
    ).pipe(
      Effect.mapError((cause) => storeError("Failed to update monitor.", cause)),
      Effect.asVoid,
    );

  const updatePollState: PullRequestMonitorStoreApi["updatePollState"] = (
    record,
    cursor,
    options,
  ) => {
    // When continuing monitoring, refuse to clobber a concurrent stop().
    // Intentional disables (stop/terminal) always apply; start/resume may re-enable.
    const enabledGuard =
      record.enabled && options?.allowReenable !== true ? sql`AND enabled = 1` : sql``;
    const lease = options?.lease;
    // Fence poll commits: only the generation that observed the snapshot may write it.
    const fenceGuard = lease
      ? sql`AND EXISTS (
            SELECT 1 FROM pull_request_monitor_leases
            WHERE canonical_key = ${lease.canonicalKey}
              AND owner_id = ${lease.ownerId}
              AND generation = ${lease.generation}
              AND expires_at > ${options?.nowIso ?? record.updatedAt}
          )`
      : sql``;
    return (
      cursor
        ? sql`
            UPDATE pull_request_monitors SET
              status = ${record.status},
              enabled = ${record.enabled ? 1 : 0},
              readiness_json = ${record.readiness ? encodeUnknownJson(record.readiness) : null},
              head_sha = ${record.headSha},
              source_revision = ${record.sourceRevision},
              cursor_json = ${encodeUnknownJson(cursor)},
              last_polled_at = ${record.lastPolledAt},
              next_poll_at = ${record.nextPollAt},
              last_error = ${record.lastError},
              poll_failure_count = ${record.pollFailureCount},
              updated_at = ${record.updatedAt},
              stopped_at = ${record.stoppedAt}
            WHERE monitor_id = ${record.id}
            ${enabledGuard}
            ${fenceGuard}
          `
        : sql`
            UPDATE pull_request_monitors SET
              status = ${record.status},
              enabled = ${record.enabled ? 1 : 0},
              readiness_json = ${record.readiness ? encodeUnknownJson(record.readiness) : null},
              head_sha = ${record.headSha},
              source_revision = ${record.sourceRevision},
              last_polled_at = ${record.lastPolledAt},
              next_poll_at = ${record.nextPollAt},
              last_error = ${record.lastError},
              poll_failure_count = ${record.pollFailureCount},
              updated_at = ${record.updatedAt},
              stopped_at = ${record.stoppedAt}
            WHERE monitor_id = ${record.id}
            ${enabledGuard}
            ${fenceGuard}
          `
    ).pipe(
      Effect.mapError((cause) => storeError("Failed to update monitor poll state.", cause)),
      Effect.asVoid,
    );
  };

  const scheduleRecheck: PullRequestMonitorStoreApi["scheduleRecheck"] = (input) =>
    sql`
      UPDATE pull_request_monitors SET
        next_poll_at = ${input.nextPollAt},
        updated_at = ${input.updatedAt}
      WHERE monitor_id = ${input.monitorId}
    `.pipe(
      Effect.mapError((cause) => storeError("Failed to schedule monitor recheck.", cause)),
      Effect.asVoid,
    );

  const transferOwnershipAtomic: PullRequestMonitorStoreApi["transferOwnershipAtomic"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          // Read previous owner inside the transaction so concurrent transfers audit correctly.
          const current = yield* sql<{ owner_thread_id: string | null }>`
            SELECT owner_thread_id
            FROM pull_request_monitors
            WHERE monitor_id = ${input.monitorId}
          `;
          const fromThreadId = current[0]?.owner_thread_id ?? null;
          if (
            input.expectedOwnerThreadId !== undefined &&
            fromThreadId !== input.expectedOwnerThreadId
          ) {
            return false;
          }

          if (input.linkedReviewThreadId === undefined) {
            if (input.expectedOwnerThreadId === undefined) {
              yield* sql`
                UPDATE pull_request_monitors SET
                  owner_thread_id = ${input.ownerThreadId},
                  updated_at = ${input.updatedAt}
                WHERE monitor_id = ${input.monitorId}
              `;
            } else if (input.expectedOwnerThreadId === null) {
              yield* sql`
                UPDATE pull_request_monitors SET
                  owner_thread_id = ${input.ownerThreadId},
                  updated_at = ${input.updatedAt}
                WHERE monitor_id = ${input.monitorId}
                  AND owner_thread_id IS NULL
              `;
            } else {
              yield* sql`
                UPDATE pull_request_monitors SET
                  owner_thread_id = ${input.ownerThreadId},
                  updated_at = ${input.updatedAt}
                WHERE monitor_id = ${input.monitorId}
                  AND owner_thread_id = ${input.expectedOwnerThreadId}
              `;
            }
          } else if (input.expectedOwnerThreadId === undefined) {
            yield* sql`
              UPDATE pull_request_monitors SET
                owner_thread_id = ${input.ownerThreadId},
                linked_review_thread_id = ${input.linkedReviewThreadId},
                updated_at = ${input.updatedAt}
              WHERE monitor_id = ${input.monitorId}
            `;
          } else if (input.expectedOwnerThreadId === null) {
            yield* sql`
              UPDATE pull_request_monitors SET
                owner_thread_id = ${input.ownerThreadId},
                linked_review_thread_id = ${input.linkedReviewThreadId},
                updated_at = ${input.updatedAt}
              WHERE monitor_id = ${input.monitorId}
                AND owner_thread_id IS NULL
            `;
          } else {
            yield* sql`
              UPDATE pull_request_monitors SET
                owner_thread_id = ${input.ownerThreadId},
                linked_review_thread_id = ${input.linkedReviewThreadId},
                updated_at = ${input.updatedAt}
              WHERE monitor_id = ${input.monitorId}
                AND owner_thread_id = ${input.expectedOwnerThreadId}
            `;
          }

          // Re-read after conditional update to confirm CAS success.
          if (input.expectedOwnerThreadId !== undefined) {
            const after = yield* sql<{ owner_thread_id: string | null }>`
              SELECT owner_thread_id
              FROM pull_request_monitors
              WHERE monitor_id = ${input.monitorId}
            `;
            if ((after[0]?.owner_thread_id ?? null) !== input.ownerThreadId) {
              return false;
            }
          }

          if (fromThreadId !== input.toThreadId) {
            yield* sql`
              INSERT INTO pull_request_monitor_ownership_events (
                event_id, monitor_id, from_thread_id, to_thread_id, reason, created_at
              ) VALUES (
                ${input.eventId},
                ${input.monitorId},
                ${fromThreadId},
                ${input.toThreadId},
                ${input.reason},
                ${input.updatedAt}
              )
            `;
          }
          return true;
        }),
      )
      .pipe(Effect.mapError((cause) => storeError("Failed to transfer monitor ownership.", cause)));

  const getCursor: PullRequestMonitorStoreApi["getCursor"] = (id) =>
    sql<{ cursor_json: string | null }>`
      SELECT cursor_json FROM pull_request_monitors WHERE monitor_id = ${id}
    `.pipe(
      Effect.flatMap((rows) => {
        const raw = rows[0]?.cursor_json;
        if (!raw) return Effect.succeed(emptyCursor());
        return decodeCursor(raw).pipe(
          Effect.mapError((cause) => storeError("Could not decode monitor cursor.", cause)),
        );
      }),
      Effect.mapError((cause) =>
        isPullRequestMonitorError(cause)
          ? cause
          : storeError("Failed to load monitor cursor.", cause),
      ),
    );

  const saveSnapshot: PullRequestMonitorStoreApi["saveSnapshot"] = (input) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO pull_request_monitor_snapshots (
          snapshot_id, monitor_id, source_revision, head_sha, fetched_at,
          snapshot_json, readiness_json, events_json
        ) VALUES (
          ${input.snapshotId},
          ${input.monitorId},
          ${input.snapshot.sourceRevision},
          ${input.snapshot.headSha},
          ${input.snapshot.fetchedAt},
          ${encodeUnknownJson(input.snapshot)},
          ${encodeUnknownJson(input.readiness)},
          ${encodeUnknownJson(input.events)}
        )
      `;
      yield* sql`
        DELETE FROM pull_request_monitor_snapshots
        WHERE monitor_id = ${input.monitorId}
          AND snapshot_id NOT IN (
            SELECT snapshot_id FROM pull_request_monitor_snapshots
            WHERE monitor_id = ${input.monitorId}
            ORDER BY fetched_at DESC
            LIMIT ${MAX_RETAINED_SNAPSHOTS}
          )
      `;
    }).pipe(
      Effect.mapError((cause) => storeError("Failed to save monitor snapshot.", cause)),
      Effect.asVoid,
    );

  const commitPollObservation: PullRequestMonitorStoreApi["commitPollObservation"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          // Fresh transaction time, not the caller's poll-start time: a provider read
          // that outlived the TTL must be fenced even though nobody replaced the lease.
          const openedAt = yield* isoNow;
          if (!(yield* holdsLease(input.lease, openedAt))) {
            return yield* new PollLeaseFenced({});
          }
          // Ingestion and the cursor advance commit together: a failed ingest rolls the
          // cursor back, so an actionable event can never be observed and then dropped.
          const feedback = yield* input.ingest;
          // Ingestion is durable work of its own, so the fence is re-read against the
          // clock as it stands at write time; losing it rolls the ingest back too.
          const commitAt = yield* isoNow;
          if (!(yield* holdsLease(input.lease, commitAt))) {
            return yield* new PollLeaseFenced({});
          }
          const { record, readiness } = input.finalize(feedback, commitAt);
          yield* saveSnapshot({
            snapshotId: input.snapshotId,
            monitorId: record.id,
            snapshot: input.snapshot,
            readiness,
            events: input.events,
          });
          yield* updatePollState(record, input.cursor, {
            lease: input.lease,
            nowIso: commitAt,
          });
          return { committed: true, record };
        }),
      )
      .pipe(
        Effect.catchTag("PullRequestMonitorPollLeaseFenced", () =>
          Effect.succeed({ committed: false, record: null }),
        ),
        Effect.mapError((cause) =>
          isPullRequestMonitorError(cause)
            ? cause
            : storeError("Failed to commit monitor poll observation.", cause),
        ),
      );

  const latestSnapshot: PullRequestMonitorStoreApi["latestSnapshot"] = (monitorId) =>
    sql<SnapshotRow>`
      SELECT * FROM pull_request_monitor_snapshots
      WHERE monitor_id = ${monitorId}
      ORDER BY fetched_at DESC
      LIMIT 1
    `.pipe(
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (!row) return Effect.succeed(null);
        return Effect.gen(function* () {
          const snapshot = (yield* decodeSnapshotJson(
            row.snapshot_json,
          )) as PullRequestMonitorSnapshot;
          const events = (yield* decodeEventsJson(
            row.events_json,
          )) as ReadonlyArray<PullRequestMonitorActionableEvent>;
          return { snapshot, events };
        }).pipe(Effect.mapError((cause) => storeError("Could not decode snapshot.", cause)));
      }),
      Effect.mapError((cause) =>
        isPullRequestMonitorError(cause)
          ? cause
          : storeError("Failed to load latest snapshot.", cause),
      ),
    );

  const tryAcquireLease: PullRequestMonitorStoreApi["tryAcquireLease"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* sql<{
        owner_id: string;
        generation: number;
        expires_at: string;
      }>`
        SELECT owner_id, generation, expires_at
        FROM pull_request_monitor_leases
        WHERE canonical_key = ${input.canonicalKey}
      `;
      const row = existing[0];
      // Reject every unexpired lease, including same-process ownerId. This is a
      // single poll-attempt claim, not a renewable process lock.
      if (row && row.expires_at > input.nowIso) {
        return null;
      }
      const generation = (row?.generation ?? 0) + 1;
      yield* sql`
        INSERT INTO pull_request_monitor_leases (
          canonical_key, owner_id, generation, acquired_at, expires_at
        ) VALUES (
          ${input.canonicalKey}, ${input.ownerId}, ${generation}, ${input.nowIso}, ${input.expiresAt}
        )
        ON CONFLICT(canonical_key) DO UPDATE SET
          owner_id = excluded.owner_id,
          generation = excluded.generation,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at
        WHERE pull_request_monitor_leases.expires_at <= ${input.nowIso}
      `;
      const confirm = yield* sql<{ owner_id: string; generation: number; expires_at: string }>`
        SELECT owner_id, generation, expires_at FROM pull_request_monitor_leases
        WHERE canonical_key = ${input.canonicalKey}
      `;
      const held = confirm[0];
      if (!held || held.owner_id !== input.ownerId || held.expires_at !== input.expiresAt) {
        return null;
      }
      return {
        canonicalKey: input.canonicalKey,
        ownerId: input.ownerId,
        generation: held.generation,
        expiresAt: held.expires_at,
      } satisfies PullRequestMonitorPollLease;
    }).pipe(Effect.mapError((cause) => storeError("Failed to acquire monitor lease.", cause)));

  const holdsLease: PullRequestMonitorStoreApi["holdsLease"] = (lease, nowIso) =>
    sql<{ readonly held: number }>`
      SELECT COUNT(*) AS held FROM pull_request_monitor_leases
      WHERE canonical_key = ${lease.canonicalKey}
        AND owner_id = ${lease.ownerId}
        AND generation = ${lease.generation}
        AND expires_at > ${nowIso}
    `.pipe(
      Effect.map((rows) => (rows[0]?.held ?? 0) > 0),
      Effect.mapError((cause) => storeError("Failed to verify monitor lease.", cause)),
    );

  const releaseLease: PullRequestMonitorStoreApi["releaseLease"] = (lease) =>
    sql`
      DELETE FROM pull_request_monitor_leases
      WHERE canonical_key = ${lease.canonicalKey}
        AND owner_id = ${lease.ownerId}
        AND generation = ${lease.generation}
    `.pipe(
      Effect.mapError((cause) => storeError("Failed to release lease.", cause)),
      Effect.asVoid,
    );

  const getHostCooldownUntil: PullRequestMonitorStoreApi["getHostCooldownUntil"] = (
    hostKey,
    nowIso,
  ) =>
    sql<{ cooldown_until: string }>`
      SELECT cooldown_until FROM pull_request_monitor_host_cooldowns
      WHERE host_key = ${hostKey} AND cooldown_until > ${nowIso}
    `.pipe(
      Effect.map((rows) => rows[0]?.cooldown_until ?? null),
      Effect.mapError((cause) => storeError("Failed to read host cooldown.", cause)),
    );

  const setHostCooldown: PullRequestMonitorStoreApi["setHostCooldown"] = (input) =>
    sql`
      INSERT INTO pull_request_monitor_host_cooldowns (
        host_key, cooldown_until, reason, updated_at
      ) VALUES (
        ${input.hostKey}, ${input.cooldownUntil}, ${input.reason}, ${input.nowIso}
      )
      ON CONFLICT(host_key) DO UPDATE SET
        cooldown_until = excluded.cooldown_until,
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.mapError((cause) => storeError("Failed to set host cooldown.", cause)),
      Effect.asVoid,
    );

  const recordOwnershipEvent: PullRequestMonitorStoreApi["recordOwnershipEvent"] = (input) =>
    sql`
      INSERT INTO pull_request_monitor_ownership_events (
        event_id, monitor_id, from_thread_id, to_thread_id, reason, created_at
      ) VALUES (
        ${input.eventId},
        ${input.monitorId},
        ${input.fromThreadId},
        ${input.toThreadId},
        ${input.reason},
        ${input.createdAt}
      )
    `.pipe(
      Effect.mapError((cause) => storeError("Failed to record ownership event.", cause)),
      Effect.asVoid,
    );

  const fallbackLaunchRow = (row: {
    launch_id: string;
    command_id: string;
    thread_id: string | null;
    reason: string;
    status: string;
    error: string | null;
    created_at: string;
    updated_at: string | null;
  }): PullRequestMonitorFallbackLaunchRecord => ({
    launchId: row.launch_id,
    commandId: row.command_id,
    threadId: row.thread_id,
    reason: row.reason,
    status: row.status as PullRequestMonitorFallbackLaunchStatus,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  });

  const latestFallbackLaunch: PullRequestMonitorStoreApi["latestFallbackLaunch"] = (monitorId) =>
    sql<{
      launch_id: string;
      command_id: string;
      thread_id: string | null;
      reason: string;
      status: string;
      error: string | null;
      created_at: string;
      updated_at: string | null;
    }>`
      SELECT launch_id, command_id, thread_id, reason, status, error, created_at, updated_at
      FROM pull_request_monitor_fallback_launches
      WHERE monitor_id = ${monitorId}
      ORDER BY created_at DESC
      LIMIT 1
    `.pipe(
      Effect.map((rows) => (rows[0] ? fallbackLaunchRow(rows[0]) : null)),
      Effect.mapError((cause) => storeError("Failed to load fallback launch.", cause)),
    );

  const listStaleFallbackLaunches: PullRequestMonitorStoreApi["listStaleFallbackLaunches"] = (
    input,
  ) =>
    sql<{
      launch_id: string;
      monitor_id: string;
      command_id: string;
      thread_id: string | null;
      reason: string;
      status: string;
      error: string | null;
      created_at: string;
      updated_at: string | null;
    }>`
      SELECT launch_id, monitor_id, command_id, thread_id, reason, status, error, created_at, updated_at
      FROM pull_request_monitor_fallback_launches
      WHERE status NOT IN ('launched', 'failed', 'abandoned')
        AND COALESCE(updated_at, created_at) <= ${input.olderThan}
      ORDER BY COALESCE(updated_at, created_at) ASC
      LIMIT ${input.limit}
    `.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({ ...fallbackLaunchRow(row), monitorId: row.monitor_id })),
      ),
      Effect.mapError((cause) => storeError("Failed to list stale fallback launches.", cause)),
    );

  const recordFallbackLaunch: PullRequestMonitorStoreApi["recordFallbackLaunch"] = (input) =>
    sql`
      INSERT INTO pull_request_monitor_fallback_launches (
        launch_id, monitor_id, command_id, thread_id, reason, status, error, created_at, updated_at
      ) VALUES (
        ${input.launchId},
        ${input.monitorId},
        ${input.commandId},
        ${input.threadId},
        ${input.reason},
        ${input.status},
        ${input.error},
        ${input.createdAt},
        ${input.createdAt}
      )
      ON CONFLICT(launch_id) DO UPDATE SET
        thread_id = COALESCE(excluded.thread_id, pull_request_monitor_fallback_launches.thread_id),
        status = excluded.status,
        error = excluded.error,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.mapError((cause) => storeError("Failed to record fallback launch.", cause)),
      Effect.asVoid,
    );

  return {
    canonicalKey: formatPullRequestMonitorCanonicalKey,
    getById,
    getByCanonicalKey,
    getByProjectRef,
    list,
    listEnabledPage,
    listDue,
    insert,
    update,
    updatePollState,
    scheduleRecheck,
    transferOwnershipAtomic,
    getCursor,
    saveSnapshot,
    commitPollObservation,
    latestSnapshot,
    tryAcquireLease,
    holdsLease,
    releaseLease,
    getHostCooldownUntil,
    setHostCooldown,
    recordOwnershipEvent,
    latestFallbackLaunch,
    listStaleFallbackLaunches,
    recordFallbackLaunch,
  } satisfies PullRequestMonitorStoreApi;
});

export const PullRequestMonitorStore = { make };
