import {
  PullRequestDiffStat,
  PullRequestListStatsInput,
  type PullRequestListStatsResult,
  type PullRequestRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { persistQuery, type QueryPersistence } from "./queryPersistence.ts";

const requestKey = Schema.fromJsonString(Schema.Tuple([Schema.String, PullRequestListStatsInput]));
const statKey = (ref: PullRequestRef) =>
  JSON.stringify(["pull-request-stat", ref.projectId, ref.host ?? "", ref.repository, ref.number]);

export function persistPullRequestStats(): QueryPersistence<PullRequestListStatsResult> {
  const row = persistQuery(PullRequestDiffStat);
  return {
    load: Effect.fn("pullRequestStatsPersistence.load")(
      function* (environmentId, key) {
        const [, input] = yield* Schema.decodeEffect(requestKey)(key);
        const rows = yield* Effect.forEach(input.refs, (ref) =>
          row.load(environmentId, statKey(ref)),
        );
        const stats = rows.flatMap((value) => (Option.isSome(value) ? [value.value] : []));
        return stats.length ? Option.some({ stats }) : Option.none();
      },
      Effect.orElseSucceed(() => Option.none()),
    ),
    save: Effect.fn("pullRequestStatsPersistence.save")(
      function* (environmentId, key, result) {
        const [, input] = yield* Schema.decodeEffect(requestKey)(key);
        yield* Effect.forEach(result.stats, (stat) => {
          const ref = input.refs.find(
            (ref) =>
              ref.projectId === stat.projectId &&
              ref.repository === stat.repository &&
              ref.number === stat.number,
          );
          return ref ? row.save(environmentId, statKey(ref), stat) : Effect.void;
        });
      },
      (effect, _environmentId, _key, _result) => effect.pipe(Effect.ignore),
    ),
  };
}
