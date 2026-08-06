import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProjectionThreadReviewResult from "./041_ProjectionThreadReviewResult.ts";
import ProjectionThreadsPullRequest from "./066_ProjectionThreadsPullRequest.ts";

/**
 * PR-review snapshots are immutable, explicit PR provenance. Older review
 * threads stored that snapshot before thread.pullRequest existed, so repair
 * only those rows without consulting mutable checkout or branch state.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ProjectionThreadsPullRequest;
  yield* ProjectionThreadReviewResult;

  yield* sql`
    UPDATE projection_threads
    SET pull_request_json = json_object(
      'number', json_extract(review_snapshot_json, '$.scope.number'),
      'title', json_extract(review_snapshot_json, '$.scope.title'),
      'url', json_extract(review_snapshot_json, '$.scope.url'),
      'baseBranch', json_extract(review_snapshot_json, '$.scope.baseBranch'),
      'headBranch', json_extract(review_snapshot_json, '$.scope.headBranch'),
      'state', NULL
    )
    WHERE pull_request_json = 'null'
      AND json_extract(review_snapshot_json, '$.scope.kind') = 'pull-request'
      AND json_type(review_snapshot_json, '$.scope.number') = 'integer'
      AND json_type(review_snapshot_json, '$.scope.title') = 'text'
      AND json_type(review_snapshot_json, '$.scope.url') = 'text'
      AND json_type(review_snapshot_json, '$.scope.baseBranch') = 'text'
      AND json_type(review_snapshot_json, '$.scope.headBranch') = 'text'
  `;
});
