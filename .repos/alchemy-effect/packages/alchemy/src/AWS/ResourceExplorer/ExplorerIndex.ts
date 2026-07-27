import * as re2 from "@distilled.cloud/aws/resource-explorer-2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

/**
 * The type of a Resource Explorer index.
 *
 * - `LOCAL` — indexes resources in its own region only.
 * - `AGGREGATOR` — additionally replicates resource information from every
 *   other region's local index, enabling account-wide search from this
 *   region. Only one aggregator index may exist per account.
 */
export type IndexType = "LOCAL" | "AGGREGATOR";

export interface IndexProps {
  /**
   * The index type. Promote to `AGGREGATOR` to enable cross-region search
   * from this region; demote back to `LOCAL` to stop replication. Note
   * that after demoting an aggregator index AWS enforces a 24-hour wait
   * before another index can be promoted.
   * @default "LOCAL"
   */
  type?: IndexType;

  /**
   * Tags to apply to the index. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

/** @resource */
export interface Index extends Resource<
  "AWS.ResourceExplorer.Index",
  IndexProps,
  {
    /** ARN of the index, e.g. `arn:aws:resource-explorer-2:us-west-2:123456789012:index/uuid`. */
    indexArn: string;
    /** The current index type (`LOCAL` or `AGGREGATOR`). */
    indexType: string;
    /** Lifecycle state of the index (`CREATING`, `ACTIVE`, `UPDATING`, ...). */
    indexState: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Resource Explorer index — the region singleton that turns on
 * resource indexing so resources in the region can be searched.
 *
 * Only one index can exist per region, so this is a capture-and-restore
 * singleton: adopting an index that Alchemy did not create requires
 * `--adopt` (ownership is tracked through the index's tags), and destroy
 * turns Resource Explorer off for the region (deleting every view in it).
 *
 * The first index created in an account also creates the
 * `AWSServiceRoleForResourceExplorer` service-linked role.
 *
 * @section Turning on Resource Explorer
 * @example Local index
 * ```typescript
 * const index = yield* AWS.ResourceExplorer.Index("Index", {});
 * ```
 *
 * @example Aggregator index for cross-region search
 * ```typescript
 * const index = yield* AWS.ResourceExplorer.Index("Index", {
 *   type: "AGGREGATOR",
 * });
 * ```
 *
 * @section Searching
 * Search always goes through a view — see `AWS.ResourceExplorer.View` and
 * the `AWS.ResourceExplorer.Search` binding.
 */
const IndexResource = Resource<Index>("AWS.ResourceExplorer.Index");

export { IndexResource as Index };

/**
 * `GetIndex` keeps returning the most recent index long after it is
 * deleted (`State: "DELETED"` has been observed months later), so both
 * the typed `ResourceNotFoundException` and a `DELETING`/`DELETED` state
 * mean "no index in this region".
 */
const observeIndex = re2.getIndex({}).pipe(
  Effect.map((r): re2.GetIndexOutput | undefined =>
    r.State === "DELETED" || r.State === "DELETING" ? undefined : r,
  ),
  Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
);

/**
 * Repeat a poll until the predicate holds (bounded — a fresh index becomes
 * `ACTIVE` in ~15s; type changes usually settle in seconds when no other
 * regions replicate). Expressed as an explicitly-typed helper: inlining
 * `Effect.repeat`/`Effect.retry` in a provider lifecycle op leaves a
 * conditional type unresolved in the provider's inferred layer type, which
 * declaration emit widens to an `unknown` R — poisoning `AWS.providers()`.
 */
const repeatUntil = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  until: (a: A) => boolean,
): Effect.Effect<A, E, R> =>
  Effect.repeat(self, {
    schedule: Schedule.spaced("2 seconds"),
    until,
    times: 30,
  });

/**
 * Retry `ConflictException` on a bounded schedule — creating an index
 * while the previous one is still `DELETING` (or racing a peer create)
 * conflicts transiently.
 */
const retryWhileConflict = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(10)]),
  });

const toTagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
};

const toAttrs = (live: re2.GetIndexOutput): Index["Attributes"] => ({
  indexArn: live.Arn!,
  indexType: live.Type ?? "LOCAL",
  indexState: live.State ?? "ACTIVE",
});

export const IndexProvider = () =>
  Provider.effect(
    IndexResource,
    Effect.gen(function* () {
      return IndexResource.Provider.of({
        stables: ["indexArn"],

        read: Effect.fn(function* ({ id }) {
          const live = yield* observeIndex;
          if (!live) return undefined;
          const attrs = toAttrs(live);
          const tags = toTagRecord(live.Tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        // Region singleton — report the single index, if any.
        list: () =>
          Effect.gen(function* () {
            const live = yield* observeIndex;
            return live ? [toAttrs(live)] : [];
          }),

        reconcile: Effect.fn(function* ({ id, news, session }) {
          const desiredType: IndexType = news.type ?? "LOCAL";
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative. A DELETED index is
          //    treated as absent (see observeIndex).
          let live = yield* observeIndex;

          // 2. ENSURE — create when missing. ConflictException covers both
          //    a race with a peer create and a previous index still
          //    DELETING; retry bounded, then fall through to observation.
          if (live === undefined) {
            yield* retryWhileConflict(
              re2.createIndex({ Tags: desiredTags }),
            ).pipe(
              Effect.catchTag("ConflictException", () => Effect.void),
              Effect.asVoid,
            );
            live = yield* repeatUntil(
              re2.getIndex({}),
              (r) => r.State === "ACTIVE",
            );
          }

          // 3. SYNC TYPE — LOCAL <-> AGGREGATOR is an in-place update.
          //    Wait (bounded) for the asynchronous replication tasks to
          //    settle back to ACTIVE; if they take longer, return the
          //    observed UPDATING state and converge on the next deploy.
          if ((live.Type ?? "LOCAL") !== desiredType) {
            yield* retryWhileConflict(
              re2.updateIndexType({ Arn: live.Arn!, Type: desiredType }),
            );
            live = yield* repeatUntil(
              re2.getIndex({}),
              (r) => r.State === "ACTIVE",
            );
          }

          // 4. SYNC TAGS — diff against OBSERVED cloud tags so adoption
          //    converges (createIndex Tags only apply on first create).
          const observedTags = toTagRecord(live.Tags);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* re2.tagResource({
              resourceArn: live.Arn!,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* re2.untagResource({
              resourceArn: live.Arn!,
              tagKeys: removed,
            });
          }

          yield* session.note(live.Arn!);
          return {
            indexArn: live.Arn!,
            indexType: live.Type ?? desiredType,
            indexState: live.State ?? "ACTIVE",
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          // Idempotent: the index may already be gone (or replaced by a
          // foreign one with a different ARN — never delete that one).
          yield* re2.deleteIndex({ Arn: output.indexArn }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            Effect.asVoid,
          );
        }),
      });
    }),
  );
