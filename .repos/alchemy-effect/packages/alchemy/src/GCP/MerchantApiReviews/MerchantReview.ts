import * as reviews from "@distilled.cloud/gcp/merchantapi_reviews_v1beta";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  accountIdOf,
  configuredAccountIds,
  dataSourceNameOf,
  DEFAULT_COUNTRY,
  DEFAULT_LANGUAGE,
  DEFAULT_REVIEW_TIME,
  findOwnedMerchantReview,
  getMerchantReview,
  hasAlchemyOwnership,
  jsonEqual,
  lastSegment,
  listMerchantReviewsAt,
  merchantReviewNameOf,
  normalizeCustomAttributes,
  ownedByAlchemy,
  parseOwnership,
  parentOf,
  stampCustomAttributes,
  stripCustomAttributes,
  toResourceId,
  type ReviewCustomAttribute,
} from "./internal.ts";

export type MerchantReviewAttributesProps = {
  /** Reviewer's overall rating of the merchant. */
  rating?: number;
  /** Title of the review. */
  title?: string;
  /**
   * Unique, stable identifier for the merchant being reviewed. Defaults
   * to the Merchant Center account id.
   */
  merchantId?: string;
  /** When true, the reviewer remains anonymous. */
  isAnonymous?: boolean;
  /**
   * Timestamp when the review was written (RFC3339).
   * @default "2020-01-01T00:00:00Z"
   */
  reviewTime?: string;
  /** URL of the merchant's main website. */
  merchantLink?: string;
  /** How the review was collected. */
  collectionMethod?:
    | reviews.MerchantReviewAttributesCollectionMethodEnum
    | (string & {});
  /** Publisher-system identifier for the review author. */
  reviewerId?: string;
  /**
   * BCP-47 language of the review.
   * @default "en"
   */
  reviewLanguage?: string;
  /**
   * ISO 3166-1 alpha-2 country where the reviewer ordered.
   * @default "US"
   */
  reviewCountry?: string;
  /** Human-readable merchant display name. */
  merchantDisplayName?: string;
  /** Landing page that hosts reviews for this merchant. */
  merchantRatingLink?: string;
  /** Maximum possible rating (must be greater than `minRating`). */
  maxRating?: string;
  /** Minimum possible rating (worst value, not "no rating"). */
  minRating?: string;
  /** Display name of the review author. */
  reviewerUsername?: string;
  /**
   * Freeform review text, sent verbatim.
   */
  content?: string;
};

export type MerchantReviewProps = {
  /**
   * Merchant Center account id (the `{account}` segment of
   * `accounts/{account}`). Immutable — changing it replaces the review.
   */
  account: string;
  /**
   * Merchant-reviews data source. Full name
   * `accounts/{account}/dataSources/{datasource}` or the data source id.
   */
  dataSource: string;
  /**
   * User-provided merchant review id. If omitted, a unique id is
   * generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the review.
   */
  merchantReviewId?: string;
  /**
   * Merchant review attributes. `merchantId`, `reviewTime`, and
   * `content` are required by the API; omitted values get defaults.
   */
  merchantReviewAttributes?: MerchantReviewAttributesProps;
  /**
   * Custom (merchant-provided) attributes. Alchemy ownership keys are
   * merged in automatically.
   */
  customAttributes?: ReviewCustomAttribute[];
};

export type MerchantReview = Resource<
  "GCP.MerchantApiReviews.MerchantReview",
  MerchantReviewProps,
  {
    /** Full resource name `accounts/{account}/merchantReviews/{id}`. */
    name: string;
    /** Merchant Center account id. */
    account: string;
    /** User-provided merchant review id. */
    merchantReviewId: string;
    /** Primary data source of the review. */
    dataSource: string | undefined;
    /** Review attributes with the Alchemy ownership prefix stripped. */
    merchantReviewAttributes: MerchantReviewAttributesProps | undefined;
    /** User custom attributes (Alchemy ownership keys stripped). */
    customAttributes: ReviewCustomAttribute[];
    /** Server-computed create time. */
    createTime: string | undefined;
    /** Server-computed last update time. */
    lastUpdateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Merchant Center merchant review (Merchant API Reviews).
 *
 * Reviews have no labels field — Alchemy stamps ownership into
 * `customAttributes` (never the review text) so `list` / nuke can find
 * them. `account` and `merchantReviewId` are identity.
 * `insertAccountsMerchantReviews` is a full-document upsert, so updates
 * replace the review in place. Creating a review requires a Merchant
 * Center account enrolled in merchant reviews and a merchant-reviews
 * data source.
 *
 * ### Creating a Merchant Review
 * **Example:** Generated id
 * ```typescript
 * const review = yield* GCP.MerchantApiReviews.MerchantReview("Storefront", {
 *   account: "123456",
 *   dataSource: "accounts/123456/dataSources/789",
 *   merchantReviewAttributes: {
 *     title: "Great shop",
 *     content: "Fast shipping",
 *     rating: 5,
 *   },
 * });
 * ```
 *
 * **Example:** Explicit id
 * ```typescript
 * const review = yield* GCP.MerchantApiReviews.MerchantReview("Storefront", {
 *   account: "123456",
 *   dataSource: "accounts/123456/dataSources/789",
 *   merchantReviewId: "storefront-2020",
 *   merchantReviewAttributes: {
 *     title: "Great shop",
 *     content: "Fast shipping",
 *     rating: 5,
 *     reviewLanguage: "en",
 *     reviewCountry: "US",
 *   },
 * });
 * ```
 *
 * ### Updating a Merchant Review
 * **Example:** Change the title and rating
 * ```typescript
 * const review = yield* GCP.MerchantApiReviews.MerchantReview("Storefront", {
 *   account: "123456",
 *   dataSource: "accounts/123456/dataSources/789",
 *   merchantReviewAttributes: {
 *     title: "Even better",
 *     content: "Fast shipping and packing",
 *     rating: 5,
 *   },
 * });
 * ```
 *
 * @resource
 * @category MerchantApiReviews
 */
export const MerchantReview = Resource<MerchantReview>(
  "GCP.MerchantApiReviews.MerchantReview",
);

export class MerchantReviewNotResolved extends Data.TaggedError(
  "GCP.MerchantApiReviews.MerchantReviewNotResolved",
)<{
  name: string;
}> {}

const attributesOf = (
  attrs: reviews.MerchantReviewAttributes | undefined,
): MerchantReviewAttributesProps | undefined => {
  if (attrs === undefined) return undefined;
  return {
    rating: attrs.rating,
    title: attrs.title,
    merchantId: attrs.merchantId,
    isAnonymous: attrs.isAnonymous,
    reviewTime: attrs.reviewTime,
    merchantLink: attrs.merchantLink,
    collectionMethod: attrs.collectionMethod,
    reviewerId: attrs.reviewerId,
    reviewLanguage: attrs.reviewLanguage,
    reviewCountry: attrs.reviewCountry,
    merchantDisplayName: attrs.merchantDisplayName,
    merchantRatingLink: attrs.merchantRatingLink,
    maxRating: attrs.maxRating,
    minRating: attrs.minRating,
    reviewerUsername: attrs.reviewerUsername,
    content: parseOwnership(attrs.content).text,
  };
};

const toAttrs = (
  review: reviews.MerchantReview,
  account: string,
  dataSource?: string,
) => {
  const merchantReviewId =
    review.merchantReviewId ?? (review.name ? lastSegment(review.name) : "");
  return {
    name: review.name ?? merchantReviewNameOf(account, merchantReviewId),
    account: accountIdOf(account),
    merchantReviewId,
    dataSource: review.dataSource ?? dataSource,
    merchantReviewAttributes: attributesOf(review.merchantReviewAttributes),
    customAttributes: stripCustomAttributes(review.customAttributes),
    createTime: review.merchantReviewStatus?.createTime,
    lastUpdateTime: review.merchantReviewStatus?.lastUpdateTime,
  };
};

const desiredAttributes = (input: {
  account: string;
  ownership: Record<string, string>;
  attrs: MerchantReviewAttributesProps | undefined;
}): reviews.MerchantReviewAttributes => ({
  rating: input.attrs?.rating,
  title: input.attrs?.title,
  merchantId: input.attrs?.merchantId ?? input.account,
  isAnonymous: input.attrs?.isAnonymous,
  reviewTime: input.attrs?.reviewTime ?? DEFAULT_REVIEW_TIME,
  merchantLink: input.attrs?.merchantLink,
  collectionMethod: input.attrs?.collectionMethod,
  reviewerId: input.attrs?.reviewerId,
  reviewLanguage: input.attrs?.reviewLanguage ?? DEFAULT_LANGUAGE,
  reviewCountry: input.attrs?.reviewCountry ?? DEFAULT_COUNTRY,
  merchantDisplayName: input.attrs?.merchantDisplayName,
  merchantRatingLink: input.attrs?.merchantRatingLink,
  maxRating: input.attrs?.maxRating,
  minRating: input.attrs?.minRating,
  reviewerUsername: input.attrs?.reviewerUsername,
  content: input.attrs?.content,
});

const desiredBody = (input: {
  merchantReviewId: string;
  attributes: reviews.MerchantReviewAttributes;
  customAttributes: reviews.CustomAttribute[];
}): reviews.MerchantReview => ({
  merchantReviewId: input.merchantReviewId,
  merchantReviewAttributes: input.attributes,
  customAttributes: input.customAttributes,
});

const reviewNeedsSync = (
  current: reviews.MerchantReview,
  desired: reviews.MerchantReview,
) =>
  !jsonEqual(current.merchantReviewId, desired.merchantReviewId) ||
  !jsonEqual(
    current.merchantReviewAttributes,
    desired.merchantReviewAttributes,
  ) ||
  !jsonEqual(
    normalizeCustomAttributes(current.customAttributes),
    normalizeCustomAttributes(desired.customAttributes),
  );

export const MerchantReviewProvider = () =>
  Provider.succeed(MerchantReview, {
    stables: ["name", "account", "merchantReviewId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAccount = olds?.account ?? output?.account;
      if (
        previousAccount !== undefined &&
        accountIdOf(news.account) !== accountIdOf(previousAccount)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.merchantReviewId ?? output?.merchantReviewId;
      if (
        previousId !== undefined &&
        news.merchantReviewId !== undefined &&
        news.merchantReviewId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const account = olds?.account ?? output?.account ?? "";
      const merchantReviewId = yield* toResourceId(
        id,
        olds?.merchantReviewId,
        output?.merchantReviewId,
      );
      const name =
        output?.name ?? merchantReviewNameOf(account, merchantReviewId);
      let existing = yield* getMerchantReview(name);
      if (existing === undefined && account) {
        existing = yield* findOwnedMerchantReview(
          id,
          account,
          merchantReviewId,
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        account,
        olds?.dataSource ?? output?.dataSource,
      );
      return (yield* ownedByAlchemy(id, {
        customAttributes: existing.customAttributes,
        content: existing.merchantReviewAttributes?.content,
      }))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const accounts = yield* configuredAccountIds();
        const pages = yield* Effect.forEach(
          accounts,
          (account) => listMerchantReviewsAt(account),
          { concurrency: 4 },
        );
        const attrs = [];
        for (let i = 0; i < pages.length; i++) {
          const account = accounts[i]!;
          for (const review of pages[i] ?? []) {
            if (
              !hasAlchemyOwnership({
                customAttributes: review.customAttributes,
                content: review.merchantReviewAttributes?.content,
              })
            ) {
              continue;
            }
            attrs.push(toAttrs(review, account, review.dataSource));
          }
        }
        return attrs;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const account = accountIdOf(news.account);
      const merchantReviewId = yield* toResourceId(
        id,
        news.merchantReviewId,
        output?.merchantReviewId,
      );
      const dataSource = dataSourceNameOf(account, news.dataSource);
      const name =
        output?.name ?? merchantReviewNameOf(account, merchantReviewId);
      const ownership = yield* createInternalLabels(id);
      const attributes = desiredAttributes({
        account,
        ownership,
        attrs: news.merchantReviewAttributes,
      });
      const customAttributes = stampCustomAttributes(
        ownership,
        news.customAttributes,
      );
      const desired = desiredBody({
        merchantReviewId,
        attributes,
        customAttributes,
      });

      let current = yield* getMerchantReview(name);
      if (current === undefined) {
        current = yield* findOwnedMerchantReview(id, account, merchantReviewId);
      }

      const upsert = () =>
        reviews
          .insertAccountsMerchantReviews({
            parent: parentOf(account),
            dataSource,
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => getMerchantReview(name)));

      if (current === undefined) {
        current = (yield* upsert()) ?? undefined;
      } else if (reviewNeedsSync(current, desired)) {
        current = (yield* upsert()) ?? current;
      }

      if (current === undefined) {
        return yield* new MerchantReviewNotResolved({ name });
      }

      return toAttrs(current, account, dataSource);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* reviews
        .deleteAccountsMerchantReviews({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
