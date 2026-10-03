import {
  GitActivityLogEntry,
  GitActivityLogError,
  GitPullRequestAssociation,
  IsoDateTime,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { threadPullRequestIdentity } from "@t3tools/shared/threadPullRequests";

import { GitActivityLedger, type GitActivityRecord } from "../Services/GitActivityLedger.ts";
import { ProjectionThreadPullRequestRepository } from "../Services/ProjectionThreadPullRequests.ts";

export const GIT_ACTIVITY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const GIT_ACTIVITY_ROW_CAP = 10_000;
export const GIT_ACTIVITY_LOG_MAX_LIMIT = 500;

const GitActivityDbRow = Schema.Struct({
  id: GitActivityLogEntry.fields.id,
  timestamp: IsoDateTime,
  operation: GitActivityLogEntry.fields.operation,
  args: Schema.fromJsonString(Schema.Array(Schema.String)),
  exitCode: GitActivityLogEntry.fields.exitCode,
  durationMs: GitActivityLogEntry.fields.durationMs,
  cwd: GitActivityLogEntry.fields.cwd,
  threadId: Schema.NullOr(ThreadId),
  pullRequests: Schema.fromJsonString(Schema.Array(GitPullRequestAssociation)),
});

const mapSqlFailure = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(
    Effect.catchCause(() =>
      Effect.fail(new GitActivityLogError({ message: "The Git activity ledger is unavailable." })),
    ),
  );

const makeGitActivityLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pullRequestRepository = yield* ProjectionThreadPullRequestRepository;

  const listRows = SqlSchema.findAll({
    Request: Schema.Struct({
      all: Schema.Finite,
      threadId: Schema.NullOr(ThreadId),
      limit: Schema.Finite,
    }),
    Result: GitActivityDbRow,
    execute: ({ all, threadId, limit }) => sql`
      SELECT
        id,
        occurred_at AS "timestamp",
        operation,
        args_json AS "args",
        exit_code AS "exitCode",
        duration_ms AS "durationMs",
        cwd,
        thread_id AS "threadId",
        pull_requests_json AS "pullRequests"
      FROM git_activity_log
      WHERE (${all} = 1 OR is_mutating = 1)
        AND (${threadId} IS NULL OR thread_id = ${threadId})
      ORDER BY id DESC
      LIMIT ${limit}
    `,
  });

  const listPullRequestCandidates = SqlSchema.findAll({
    Request: Schema.Struct({ number: Schema.Finite }),
    Result: Schema.Struct({
      pullRequest: Schema.fromJsonString(GitPullRequestAssociation),
    }),
    execute: ({ number }) => sql`
      SELECT DISTINCT linked_pr.value AS "pullRequest"
      FROM git_activity_log AS activity,
        json_each(activity.pull_requests_json) AS linked_pr
      WHERE json_extract(linked_pr.value, '$.number') = ${number}
      LIMIT ${GIT_ACTIVITY_ROW_CAP}
    `,
  });

  const prune = () => {
    const cutoff = new Date(Date.now() - GIT_ACTIVITY_RETENTION_MS).toISOString();
    return Effect.gen(function* () {
      yield* sql`DELETE FROM git_activity_log WHERE occurred_at < ${cutoff}`;
      yield* sql`
        DELETE FROM git_activity_log
        WHERE id NOT IN (
          SELECT id FROM git_activity_log ORDER BY id DESC LIMIT ${GIT_ACTIVITY_ROW_CAP}
        )
      `;
    });
  };

  const record = (entry: GitActivityRecord) =>
    mapSqlFailure(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO git_activity_log (
            occurred_at,
            operation,
            args_json,
            exit_code,
            duration_ms,
            cwd,
            thread_id,
            pull_requests_json,
            is_mutating
          ) VALUES (
            ${entry.timestamp},
            ${entry.operation},
            ${JSON.stringify(entry.args)},
            ${entry.exitCode},
            ${entry.durationMs},
            ${entry.cwd},
            ${entry.threadId},
            ${JSON.stringify(entry.pullRequests)},
            ${entry.isMutating ? 1 : 0}
          )
        `;
        yield* prune();
      }),
    );

  const threadsByPullRequest = (number: number) =>
    Effect.gen(function* () {
      const candidates = yield* listPullRequestCandidates({ number });
      const pullRequests = new Map<string, typeof GitPullRequestAssociation.Type>();
      for (const { pullRequest } of candidates) {
        const identity = threadPullRequestIdentity(pullRequest);
        const key = `${identity.host}/${identity.repository}#${identity.number}`;
        pullRequests.set(key, pullRequest);
      }

      const results = yield* Effect.forEach(
        pullRequests,
        ([key, pullRequest]) =>
          pullRequestRepository
            .listByPullRequest({ pullRequest })
            .pipe(Effect.map((rows) => [key, new Set(rows.map((row) => row.threadId))] as const)),
        { concurrency: 4 },
      );
      return new Map(results);
    });

  const list = (input: {
    readonly all: boolean;
    readonly limit: number;
    readonly threadId?: ThreadId;
    readonly pullRequestNumber?: number;
  }) =>
    mapSqlFailure(
      Effect.gen(function* () {
        yield* prune();
        const rows = yield* listRows({
          all: input.all ? 1 : 0,
          threadId: input.threadId ?? null,
          limit:
            input.pullRequestNumber === undefined
              ? Math.max(1, Math.min(input.limit, GIT_ACTIVITY_LOG_MAX_LIMIT))
              : GIT_ACTIVITY_ROW_CAP,
        });
        if (input.pullRequestNumber === undefined) return rows;

        const threads = yield* threadsByPullRequest(input.pullRequestNumber);
        return rows
          .filter((row) => {
            const threadId = row.threadId;
            if (threadId === null) return false;
            return row.pullRequests.some((pullRequest) => {
              if (pullRequest.number !== input.pullRequestNumber) return false;
              const identity = threadPullRequestIdentity(pullRequest);
              const key = `${identity.host}/${identity.repository}#${identity.number}`;
              return threads.get(key)?.has(threadId) ?? false;
            });
          })
          .slice(0, Math.max(1, Math.min(input.limit, GIT_ACTIVITY_LOG_MAX_LIMIT)));
      }),
    );

  return { record, list };
});

export const GitActivityLedgerLive = Layer.effect(GitActivityLedger, makeGitActivityLedger);
