import * as intel from "@distilled.cloud/cloudflare/intel";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Intel.IndicatorFeedPermission" as const;
type TypeId = typeof TypeId;

export interface IndicatorFeedPermissionProps {
  /**
   * The ID of the indicator feed to grant access to — e.g. `feed.feedId`.
   * Immutable — changing it triggers a replacement.
   */
  feedId: number;
  /**
   * The Cloudflare account tag of the consumer account being granted
   * access to the feed. Immutable — changing it triggers a replacement.
   */
  accountTag: string;
}

export interface IndicatorFeedPermissionAttributes {
  /** The ID of the indicator feed the grant is on. */
  feedId: number;
  /** The Cloudflare account tag of the consumer account. */
  accountTag: string;
  /** The Cloudflare account that owns the feed (the granting account). */
  accountId: string;
}

export type IndicatorFeedPermission = Resource<
  TypeId,
  IndicatorFeedPermissionProps,
  IndicatorFeedPermissionAttributes,
  never,
  Providers
>;

/**
 * A permission grant on a Cloudflare custom Indicator Feed, giving another
 * Cloudflare account access to consume the feed.
 *
 * This is an existence-only resource: it has no mutable aspects beyond its
 * identity (feed + consumer account tag), so changing either property
 * triggers a replacement. Cloudflare's add/remove endpoints are idempotent
 * PUTs, so reconcile and delete are simple ensure/remove calls.
 *
 * Cloudflare exposes no API to list the grantees of a feed from the
 * provider side (the permissions "view" endpoint lists feeds the *calling*
 * account can consume), so `read` reports the last known state.
 * @resource
 * @product Intel
 * @category Observability & Analytics
 * @section Granting Access
 * @example Grant a consumer account access to a feed
 * ```typescript
 * const feed = yield* Cloudflare.Intel.IndicatorFeed("threat-feed", {
 *   description: "Indicators observed by our honeypots",
 * });
 *
 * yield* Cloudflare.Intel.IndicatorFeedPermission("partner-access", {
 *   feedId: feed.feedId,
 *   accountTag: "023e105f4ecef8ad9ca31a8372d0c353",
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/security-center/indicator-feeds/
 */
export const IndicatorFeedPermission =
  Resource<IndicatorFeedPermission>(TypeId);

/**
 * Returns true if the given value is an IndicatorFeedPermission resource.
 */
export const isIndicatorFeedPermission = (
  value: unknown,
): value is IndicatorFeedPermission =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const IndicatorFeedPermissionProvider = () =>
  Provider.succeed(IndicatorFeedPermission, {
    stables: ["feedId", "accountTag", "accountId"],

    // Non-listable: a grant is keyed by {feedId, accountTag} from the
    // granting account's side, and Cloudflare exposes no provider-side API
    // to enumerate a feed's grantees. The only related collection op
    // (`listIndicatorFeedPermissions`, the `/permissions/view` endpoint)
    // returns feeds the *calling* account can consume — feed metadata
    // (id/name/flags) with no `accountTag` — which is the inverse
    // relationship and cannot reconstruct the `read` Attributes shape.
    list: () => Effect.succeed<IndicatorFeedPermissionAttributes[]>([]),

    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      // Identity change — both props are the resource's identity, so any
      // change is a replacement. Compare only once both sides are concrete.
      if (typeof olds?.feedId === "number" && olds.feedId !== news.feedId) {
        return { action: "replace" } as const;
      }
      if (
        typeof olds?.accountTag === "string" &&
        olds.accountTag !== news.accountTag
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      // Cloudflare exposes no provider-side API to list a feed's grantees
      // (the "view" endpoint is consumer-side), so the recorded output is
      // the best observation available. The identity is fully
      // user-specified and the add PUT is idempotent, so reconcile
      // re-asserts the grant regardless.
      return output;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Inputs have been resolved to concrete values by Plan.
      const feedId = news.feedId as number;
      const accountTag = news.accountTag;

      // Ensure — the add endpoint is an idempotent PUT: granting an
      // already-granted account succeeds, so there is no race to tolerate
      // and no observe step possible (no provider-side list API).
      yield* intel.createIndicatorFeedPermission({
        accountId: output?.accountId ?? accountId,
        feedId,
        accountTag,
      });

      return {
        feedId,
        accountTag,
        accountId: output?.accountId ?? accountId,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      // Idempotent PUT — removing a grant that is already gone succeeds.
      // A feed deleted out-of-band (or never visible) surfaces as the
      // typed IndicatorFeedNotFound, which also means the grant is gone.
      yield* intel
        .deleteIndicatorFeedPermission({
          accountId: output.accountId,
          feedId: output.feedId,
          accountTag: output.accountTag,
        })
        .pipe(Effect.catchTag("IndicatorFeedNotFound", () => Effect.void));
    }),
  });
