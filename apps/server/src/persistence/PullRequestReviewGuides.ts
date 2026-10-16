import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { PullRequestReviewGuide, ThreadPullRequestKey } from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type PullRequestReviewGuideRepositoryError,
} from "./Errors.ts";

const GuideRow = Schema.Struct({
  guide: Schema.fromJsonString(PullRequestReviewGuide),
});

export class PullRequestReviewGuideRepository extends Context.Service<
  PullRequestReviewGuideRepository,
  {
    readonly get: (
      key: ThreadPullRequestKey,
    ) => Effect.Effect<
      Option.Option<PullRequestReviewGuide>,
      PullRequestReviewGuideRepositoryError
    >;
    readonly put: (
      key: ThreadPullRequestKey,
      guide: PullRequestReviewGuide,
    ) => Effect.Effect<void, PullRequestReviewGuideRepositoryError>;
  }
>()("t3/persistence/PullRequestReviewGuides/PullRequestReviewGuideRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findGuide = SqlSchema.findOneOption({
    Request: ThreadPullRequestKey,
    Result: GuideRow,
    execute: ({ host, repository, number }) =>
      sql`
        SELECT guide_json AS "guide"
        FROM pull_request_review_guides
        WHERE host = ${host} AND repository = ${repository} AND number = ${number}
      `,
  });
  const encodeGuide = Schema.encodeEffect(Schema.fromJsonString(PullRequestReviewGuide));

  return PullRequestReviewGuideRepository.of({
    get: (key) =>
      findGuide(key).pipe(
        Effect.map(Option.map((row) => row.guide)),
        Effect.mapError((cause) =>
          Schema.isSchemaError(cause)
            ? PersistenceDecodeError.fromSchemaError("PullRequestReviewGuide", cause)
            : new PersistenceSqlError({ operation: "getPullRequestReviewGuide", cause }),
        ),
      ),
    put: (key, guide) =>
      encodeGuide(guide).pipe(
        Effect.mapError((cause) =>
          PersistenceDecodeError.fromSchemaError("PullRequestReviewGuide", cause),
        ),
        Effect.flatMap((guideJson) =>
          sql`
            INSERT INTO pull_request_review_guides (host, repository, number, guide_json)
            VALUES (${key.host}, ${key.repository}, ${key.number}, ${guideJson})
            ON CONFLICT (host, repository, number) DO UPDATE SET guide_json = excluded.guide_json
          `.pipe(
            Effect.mapError(
              (cause) => new PersistenceSqlError({ operation: "putPullRequestReviewGuide", cause }),
            ),
          ),
        ),
        Effect.asVoid,
      ),
  });
});

export const layer = Layer.effect(PullRequestReviewGuideRepository, make);
