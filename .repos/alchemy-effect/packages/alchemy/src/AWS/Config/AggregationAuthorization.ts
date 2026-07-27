import * as config from "@distilled.cloud/aws/config-service";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface AggregationAuthorizationProps {
  /**
   * The 12-digit account ID of the aggregator account that is authorized to
   * collect AWS Config data from this account. Changing it replaces the
   * authorization.
   */
  authorizedAccountId: string;
  /**
   * The region of the aggregator account that is authorized to collect AWS
   * Config data from this account. Changing it replaces the authorization.
   */
  authorizedAwsRegion: string;
  /**
   * Tags to apply to the authorization. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface AggregationAuthorization extends Resource<
  "AWS.Config.AggregationAuthorization",
  AggregationAuthorizationProps,
  {
    /** ARN of the aggregation authorization. */
    aggregationAuthorizationArn: string;
    /** The aggregator account authorized to collect data. */
    authorizedAccountId: string;
    /** The aggregator region authorized to collect data. */
    authorizedAwsRegion: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Config aggregation authorization that grants an aggregator account
 * in a specific region permission to collect AWS Config configuration and
 * compliance data from this account.
 *
 * The authorization's identity is the `(account, region)` pair — changing
 * either replaces it.
 * @resource
 * @section Authorizing an Aggregator
 * @example Authorize an aggregator account
 * ```typescript
 * import * as Config from "alchemy/AWS/Config";
 *
 * const authorization = yield* Config.AggregationAuthorization(
 *   "OrgAggregator",
 *   {
 *     authorizedAccountId: "123456789012",
 *     authorizedAwsRegion: "us-east-1",
 *   },
 * );
 * ```
 */
export const AggregationAuthorization = Resource<AggregationAuthorization>(
  "AWS.Config.AggregationAuthorization",
);

export const AggregationAuthorizationProvider = () =>
  Provider.effect(
    AggregationAuthorization,
    Effect.gen(function* () {
      // There is no Get API — enumerate and match on the (account, region)
      // identity pair.
      const observeAuthorization = Effect.fn(function* (
        accountId: string,
        region: string,
      ) {
        return yield* config.describeAggregationAuthorizations.items({}).pipe(
          Stream.filter(
            (auth) =>
              auth.AuthorizedAccountId === accountId &&
              auth.AuthorizedAwsRegion === region,
          ),
          Stream.runHead,
          Effect.map((head) => (head._tag === "Some" ? head.value : undefined)),
        );
      });

      const observedTags = (arn: string) =>
        config.listTagsForResource({ ResourceArn: arn }).pipe(
          Effect.map((r) =>
            Object.fromEntries(
              (r.Tags ?? []).flatMap((t) =>
                t.Key !== undefined ? [[t.Key, t.Value ?? ""]] : [],
              ),
            ),
          ),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed({} as Record<string, string>),
          ),
        );

      const toAttrs = (auth: config.AggregationAuthorization) => ({
        aggregationAuthorizationArn: auth.AggregationAuthorizationArn!,
        authorizedAccountId: auth.AuthorizedAccountId!,
        authorizedAwsRegion: auth.AuthorizedAwsRegion!,
      });

      return AggregationAuthorization.Provider.of({
        stables: [
          "aggregationAuthorizationArn",
          "authorizedAccountId",
          "authorizedAwsRegion",
        ],
        list: () =>
          config.describeAggregationAuthorizations.items({}).pipe(
            Stream.runCollect,
            Effect.map((auths) =>
              Array.from(auths).flatMap((auth) =>
                auth.AggregationAuthorizationArn &&
                auth.AuthorizedAccountId &&
                auth.AuthorizedAwsRegion
                  ? [toAttrs(auth)]
                  : [],
              ),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const accountId =
            output?.authorizedAccountId ?? olds?.authorizedAccountId;
          const region =
            output?.authorizedAwsRegion ?? olds?.authorizedAwsRegion;
          if (accountId === undefined || region === undefined) {
            return undefined;
          }
          const auth = yield* observeAuthorization(accountId, region);
          if (auth?.AggregationAuthorizationArn === undefined) {
            return undefined;
          }
          const attrs = toAttrs(auth);
          const tags = yield* observedTags(auth.AggregationAuthorizationArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        // The (account, region) pair IS the resource identity — any change
        // replaces it. Tags remain updatable in place.
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            olds.authorizedAccountId !== news.authorizedAccountId ||
            olds.authorizedAwsRegion !== news.authorizedAwsRegion
          ) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative.
          let live = yield* observeAuthorization(
            news.authorizedAccountId,
            news.authorizedAwsRegion,
          );

          // 2. ENSURE — PutAggregationAuthorization is idempotent: it
          //    creates when missing and is a no-op when present (create-time
          //    tags on an existing authorization are ignored, so tags are
          //    synced separately below).
          if (live === undefined) {
            live = yield* config
              .putAggregationAuthorization({
                AuthorizedAccountId: news.authorizedAccountId,
                AuthorizedAwsRegion: news.authorizedAwsRegion,
                Tags: createTagsList(desiredTags),
              })
              .pipe(Effect.map((r) => r.AggregationAuthorization));
          }

          const arn = live?.AggregationAuthorizationArn;
          if (arn === undefined) {
            // Extremely unlikely (Put returns the authorization) — fall back
            // to a fresh observation so the attrs are never fabricated.
            live = yield* observeAuthorization(
              news.authorizedAccountId,
              news.authorizedAwsRegion,
            );
          }

          // 3. SYNC TAGS — diff against OBSERVED cloud tags so adoption
          //    converges.
          const finalArn = live?.AggregationAuthorizationArn;
          if (finalArn !== undefined) {
            const currentTags = yield* observedTags(finalArn);
            const { upsert, removed } = diffTags(currentTags, desiredTags);
            if (upsert.length > 0) {
              yield* config.tagResource({
                ResourceArn: finalArn,
                Tags: upsert,
              });
            }
            if (removed.length > 0) {
              yield* config.untagResource({
                ResourceArn: finalArn,
                TagKeys: removed,
              });
            }
          }

          yield* session.note(
            `${news.authorizedAccountId}/${news.authorizedAwsRegion}`,
          );
          return {
            aggregationAuthorizationArn: finalArn!,
            authorizedAccountId: news.authorizedAccountId,
            authorizedAwsRegion: news.authorizedAwsRegion,
          };
        }),
        // DeleteAggregationAuthorization succeeds whether or not the
        // authorization still exists — idempotent by design.
        delete: Effect.fn(function* ({ output }) {
          yield* config.deleteAggregationAuthorization({
            AuthorizedAccountId: output.authorizedAccountId,
            AuthorizedAwsRegion: output.authorizedAwsRegion,
          });
        }),
      });
    }),
  );
