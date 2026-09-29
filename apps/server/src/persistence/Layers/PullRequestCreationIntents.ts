import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  GitPullRequestAssociation,
  IsoDateTime,
  PositiveInt,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  PullRequestCreationIntent,
  PullRequestCreationIntentRepository,
  type PullRequestCreationIntentRepositoryShape,
} from "../Services/PullRequestCreationIntents.ts";

const PullRequestCreationIntentDbRow = Schema.Struct({
  ...PullRequestCreationIntent.fields,
  pullRequest: Schema.NullOr(Schema.fromJsonString(GitPullRequestAssociation)),
});

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRow = SqlSchema.void({
    Request: PullRequestCreationIntent,
    execute: (intent) => sql`
      INSERT INTO pull_request_creation_intents (
        action_id,
        thread_id,
        project_id,
        cwd,
        local_branch,
        head_branch,
        head_selector,
        base_branch,
        head_sha,
        requested_at,
        next_attempt_at,
        attempt_count,
        pull_request_json
      ) VALUES (
        ${intent.actionId},
        ${intent.threadId},
        ${intent.projectId},
        ${intent.cwd},
        ${intent.localBranch},
        ${intent.headBranch},
        ${intent.headSelector},
        ${intent.baseBranch},
        ${intent.headSha},
        ${intent.requestedAt},
        ${intent.nextAttemptAt},
        ${intent.attemptCount},
        ${intent.pullRequest === null ? null : JSON.stringify(intent.pullRequest)}
      )
      ON CONFLICT (action_id) DO NOTHING
    `,
  });

  const findByActionId = SqlSchema.findOneOption({
    Request: Schema.Struct({ actionId: TrimmedNonEmptyString }),
    Result: PullRequestCreationIntentDbRow,
    execute: ({ actionId }) => sql`
      SELECT
        action_id AS "actionId",
        thread_id AS "threadId",
        project_id AS "projectId",
        cwd,
        local_branch AS "localBranch",
        head_branch AS "headBranch",
        head_selector AS "headSelector",
        base_branch AS "baseBranch",
        head_sha AS "headSha",
        requested_at AS "requestedAt",
        next_attempt_at AS "nextAttemptAt",
        attempt_count AS "attemptCount",
        pull_request_json AS "pullRequest"
      FROM pull_request_creation_intents
      WHERE action_id = ${actionId}
    `,
  });

  const listDueRows = SqlSchema.findAll({
    Request: Schema.Struct({
      now: IsoDateTime,
      limit: PositiveInt,
    }),
    Result: PullRequestCreationIntentDbRow,
    execute: ({ now, limit }) => sql`
      SELECT
        action_id AS "actionId",
        thread_id AS "threadId",
        project_id AS "projectId",
        cwd,
        local_branch AS "localBranch",
        head_branch AS "headBranch",
        head_selector AS "headSelector",
        base_branch AS "baseBranch",
        head_sha AS "headSha",
        requested_at AS "requestedAt",
        next_attempt_at AS "nextAttemptAt",
        attempt_count AS "attemptCount",
        pull_request_json AS "pullRequest"
      FROM pull_request_creation_intents
      WHERE pull_request_json IS NOT NULL OR next_attempt_at <= ${now}
      ORDER BY next_attempt_at ASC, requested_at ASC
      LIMIT ${limit}
    `,
  });

  const saveRow = SqlSchema.void({
    Request: PullRequestCreationIntent,
    execute: (intent) => sql`
      UPDATE pull_request_creation_intents
      SET
        thread_id = ${intent.threadId},
        project_id = ${intent.projectId},
        cwd = ${intent.cwd},
        local_branch = ${intent.localBranch},
        head_branch = ${intent.headBranch},
        head_selector = ${intent.headSelector},
        base_branch = ${intent.baseBranch},
        head_sha = ${intent.headSha},
        requested_at = ${intent.requestedAt},
        next_attempt_at = ${intent.nextAttemptAt},
        attempt_count = ${intent.attemptCount},
        pull_request_json = COALESCE(
          ${intent.pullRequest === null ? null : JSON.stringify(intent.pullRequest)},
          pull_request_json
        )
      WHERE action_id = ${intent.actionId}
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: Schema.Struct({ actionId: TrimmedNonEmptyString }),
    execute: ({ actionId }) => sql`
      DELETE FROM pull_request_creation_intents
      WHERE action_id = ${actionId}
    `,
  });

  const mapSqlError = (operation: string) => Effect.mapError(toPersistenceSqlError(operation));

  const repository: PullRequestCreationIntentRepositoryShape = {
    insert: (intent) =>
      insertRow(intent).pipe(mapSqlError("PullRequestCreationIntentRepository.insert")),
    getByActionId: ({ actionId }) =>
      findByActionId({ actionId }).pipe(
        mapSqlError("PullRequestCreationIntentRepository.getByActionId"),
      ),
    listDue: ({ now, limit }) =>
      listDueRows({ now, limit }).pipe(mapSqlError("PullRequestCreationIntentRepository.listDue")),
    save: (intent) => saveRow(intent).pipe(mapSqlError("PullRequestCreationIntentRepository.save")),
    deleteByActionId: ({ actionId }) =>
      deleteRow({ actionId }).pipe(
        mapSqlError("PullRequestCreationIntentRepository.deleteByActionId"),
      ),
  };

  return repository;
});

export const PullRequestCreationIntentRepositoryLive = Layer.effect(
  PullRequestCreationIntentRepository,
  makeRepository,
);
