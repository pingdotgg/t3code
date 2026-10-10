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
  findOwnedProductReview,
  getProductReview,
  hasAlchemyOwnership,
  jsonEqual,
  lastSegment,
  listProductReviewsAt,
  normalizeCustomAttributes,
  ownedByAlchemy,
  parseOwnership,
  parentOf,
  productReviewNameOf,
  stampCustomAttributes,
  stripCustomAttributes,
  toResourceId,
  type ReviewCustomAttribute,
  type ReviewLinkProps,
} from "./internal.ts";

export type ProductReviewAttributesProps = {
  /** GTINs associated with the product. */
  gtins?: string[];
  /** Brand names associated with the product. */
  brands?: string[];
  /** Minimum possible rating (worst value, not "no rating"). */
  minRating?: string;
  /** Name of the reviews aggregator, if any. */
  aggregatorName?: string;
  /** Descriptive product names. */
  productNames?: string[];
  /** Maximum possible rating (must be greater than `minRating`). */
  maxRating?: string;
  /** Advantages from the reviewer. */
  pros?: string[];
  /** How the review was collected. */
  collectionMethod?:
    | reviews.ProductReviewAttributesCollectionMethodEnum
    | (string & {});
  /** Whether the review is marked as spam. */
  isSpam?: boolean;
  /** Reviewer's overall rating of the product. */
  rating?: number;
  /** SKUs associated with the product. */
  skus?: string[];
  /** URIs of reviewer-created product images. */
  reviewerImageLinks?: string[];
  /** Publisher favicon URI. */
  publisherFavicon?: string;
  /** Name of the publisher of the product reviews. */
  publisherName?: string;
  /** Name of the reviewer. */
  reviewerUsername?: string;
  /** Publisher-system transaction id. */
  transactionId?: string;
  /**
   * Review body, sent verbatim.
   */
  content?: string;
  /** Whether the reviewer's purchase is verified. */
  isVerifiedPurchase?: boolean;
  /**
   * ISO 3166-1 alpha-2 country of the review.
   * @default "US"
   */
  reviewCountry?: string;
  /** Disadvantages from the reviewer. */
  cons?: string[];
  /** URI of the review landing page. */
  reviewLink?: ReviewLinkProps;
  /**
   * BCP-47 language of the review.
   * @default "en"
   */
  reviewLanguage?: string;
  /** Subclient identifier of the review source. */
  subclientName?: string;
  /** Publisher-system identifier for the review author. */
  reviewerId?: string;
  /** Title of the review. */
  title?: string;
  /** Product landing-page URIs. */
  productLinks?: string[];
  /**
   * Timestamp when the review was written (RFC3339).
   * @default "2020-01-01T00:00:00Z"
   */
  reviewTime?: string;
  /** ASINs associated with the product. */
  asins?: string[];
  /** When true, the reviewer remains anonymous. */
  reviewerIsAnonymous?: boolean;
  /** MPNs associated with the product. */
  mpns?: string[];
  /** Whether the review is incentivized. */
  isIncentivizedReview?: boolean;
};

export type ProductReviewProps = {
  /**
   * Merchant Center account id (the `{account}` segment of
   * `accounts/{account}`). Immutable — changing it replaces the review.
   */
  account: string;
  /**
   * Product-reviews data source. Full name
   * `accounts/{account}/dataSources/{datasource}` or the data source id.
   */
  dataSource: string;
  /**
   * Permanent publisher-system product review id. If omitted, a unique
   * id is generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the review.
   */
  productReviewId?: string;
  /**
   * Product review attributes. `reviewTime` is required by the API;
   * omitted values get defaults. When no product identifier is set,
   * `skus` defaults to the review id.
   */
  productReviewAttributes?: ProductReviewAttributesProps;
  /**
   * Custom (merchant-provided) attributes. Alchemy ownership keys are
   * merged in automatically.
   */
  customAttributes?: ReviewCustomAttribute[];
};

export type ProductReview = Resource<
  "GCP.MerchantApiReviews.ProductReview",
  ProductReviewProps,
  {
    /** Full resource name `accounts/{account}/productReviews/{id}`. */
    name: string;
    /** Merchant Center account id. */
    account: string;
    /** Publisher-system product review id. */
    productReviewId: string;
    /** Primary data source of the review. */
    dataSource: string | undefined;
    /** Review attributes with the Alchemy ownership prefix stripped. */
    productReviewAttributes: ProductReviewAttributesProps | undefined;
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
 * A Merchant Center product review (Merchant API Reviews).
 *
 * Reviews have no labels field — Alchemy stamps ownership into
 * `customAttributes` (never the review text) so `list` / nuke can find
 * them. `account` and `productReviewId` are identity.
 * `insertAccountsProductReviews` is a full-document upsert, so updates
 * replace the review in place. Creating a review requires a Merchant
 * Center account enrolled in product ratings and a product-reviews
 * data source.
 *
 * ### Creating a Product Review
 * **Example:** Generated id
 * ```typescript
 * const review = yield* GCP.MerchantApiReviews.ProductReview("Tote", {
 *   account: "123456",
 *   dataSource: "accounts/123456/dataSources/789",
 *   productReviewAttributes: {
 *     title: "Sturdy tote",
 *     content: "Holds a laptop and lunch",
 *     rating: 5,
 *     gtins: ["9780007350896"],
 *   },
 * });
 * ```
 *
 * **Example:** Explicit id
 * ```typescript
 * const review = yield* GCP.MerchantApiReviews.ProductReview("Tote", {
 *   account: "123456",
 *   dataSource: "accounts/123456/dataSources/789",
 *   productReviewId: "tote-2020",
 *   productReviewAttributes: {
 *     title: "Sturdy tote",
 *     content: "Holds a laptop and lunch",
 *     rating: 5,
 *     skus: ["tote-navy"],
 *     reviewLanguage: "en",
 *     reviewCountry: "US",
 *   },
 * });
 * ```
 *
 * ### Updating a Product Review
 * **Example:** Change the title and rating
 * ```typescript
 * const review = yield* GCP.MerchantApiReviews.ProductReview("Tote", {
 *   account: "123456",
 *   dataSource: "accounts/123456/dataSources/789",
 *   productReviewAttributes: {
 *     title: "Roomy tote",
 *     content: "Holds a laptop, lunch, and jacket",
 *     rating: 4,
 *     skus: ["tote-navy"],
 *   },
 * });
 * ```
 *
 * @resource
 * @category MerchantApiReviews
 */
export const ProductReview = Resource<ProductReview>(
  "GCP.MerchantApiReviews.ProductReview",
);

export class ProductReviewNotResolved extends Data.TaggedError(
  "GCP.MerchantApiReviews.ProductReviewNotResolved",
)<{
  name: string;
}> {}

const hasProductIdentifier = (
  attrs: ProductReviewAttributesProps | undefined,
) =>
  (attrs?.gtins?.length ?? 0) > 0 ||
  (attrs?.skus?.length ?? 0) > 0 ||
  (attrs?.mpns?.length ?? 0) > 0 ||
  (attrs?.asins?.length ?? 0) > 0;

const attributesOf = (
  attrs: reviews.ProductReviewAttributes | undefined,
): ProductReviewAttributesProps | undefined => {
  if (attrs === undefined) return undefined;
  return {
    gtins: attrs.gtins,
    brands: attrs.brands,
    minRating: attrs.minRating,
    aggregatorName: attrs.aggregatorName,
    productNames: attrs.productNames,
    maxRating: attrs.maxRating,
    pros: attrs.pros,
    collectionMethod: attrs.collectionMethod,
    isSpam: attrs.isSpam,
    rating: attrs.rating,
    skus: attrs.skus,
    reviewerImageLinks: attrs.reviewerImageLinks,
    publisherFavicon: attrs.publisherFavicon,
    publisherName: attrs.publisherName,
    reviewerUsername: attrs.reviewerUsername,
    transactionId: attrs.transactionId,
    content: parseOwnership(attrs.content).text,
    isVerifiedPurchase: attrs.isVerifiedPurchase,
    reviewCountry: attrs.reviewCountry,
    cons: attrs.cons,
    reviewLink: attrs.reviewLink,
    reviewLanguage: attrs.reviewLanguage,
    subclientName: attrs.subclientName,
    reviewerId: attrs.reviewerId,
    title: attrs.title,
    productLinks: attrs.productLinks,
    reviewTime: attrs.reviewTime,
    asins: attrs.asins,
    reviewerIsAnonymous: attrs.reviewerIsAnonymous,
    mpns: attrs.mpns,
    isIncentivizedReview: attrs.isIncentivizedReview,
  };
};

const toAttrs = (
  review: reviews.ProductReview,
  account: string,
  dataSource?: string,
) => {
  const productReviewId =
    review.productReviewId ?? (review.name ? lastSegment(review.name) : "");
  return {
    name: review.name ?? productReviewNameOf(account, productReviewId),
    account: accountIdOf(account),
    productReviewId,
    dataSource: review.dataSource ?? dataSource,
    productReviewAttributes: attributesOf(review.productReviewAttributes),
    customAttributes: stripCustomAttributes(review.customAttributes),
    createTime: review.productReviewStatus?.createTime,
    lastUpdateTime: review.productReviewStatus?.lastUpdateTime,
  };
};

const desiredAttributes = (input: {
  productReviewId: string;
  ownership: Record<string, string>;
  attrs: ProductReviewAttributesProps | undefined;
}): reviews.ProductReviewAttributes => ({
  gtins: input.attrs?.gtins,
  brands: input.attrs?.brands,
  minRating: input.attrs?.minRating,
  aggregatorName: input.attrs?.aggregatorName,
  productNames: input.attrs?.productNames,
  maxRating: input.attrs?.maxRating,
  pros: input.attrs?.pros,
  collectionMethod: input.attrs?.collectionMethod,
  isSpam: input.attrs?.isSpam,
  rating: input.attrs?.rating,
  skus: hasProductIdentifier(input.attrs)
    ? input.attrs?.skus
    : [input.productReviewId],
  reviewerImageLinks: input.attrs?.reviewerImageLinks,
  publisherFavicon: input.attrs?.publisherFavicon,
  publisherName: input.attrs?.publisherName,
  reviewerUsername: input.attrs?.reviewerUsername,
  transactionId: input.attrs?.transactionId,
  content: input.attrs?.content,
  isVerifiedPurchase: input.attrs?.isVerifiedPurchase,
  reviewCountry: input.attrs?.reviewCountry ?? DEFAULT_COUNTRY,
  cons: input.attrs?.cons,
  reviewLink: input.attrs?.reviewLink,
  reviewLanguage: input.attrs?.reviewLanguage ?? DEFAULT_LANGUAGE,
  subclientName: input.attrs?.subclientName,
  reviewerId: input.attrs?.reviewerId,
  title: input.attrs?.title,
  productLinks: input.attrs?.productLinks,
  reviewTime: input.attrs?.reviewTime ?? DEFAULT_REVIEW_TIME,
  asins: input.attrs?.asins,
  reviewerIsAnonymous: input.attrs?.reviewerIsAnonymous,
  mpns: input.attrs?.mpns,
  isIncentivizedReview: input.attrs?.isIncentivizedReview,
});

const desiredBody = (input: {
  productReviewId: string;
  attributes: reviews.ProductReviewAttributes;
  customAttributes: reviews.CustomAttribute[];
}): reviews.ProductReview => ({
  productReviewId: input.productReviewId,
  productReviewAttributes: input.attributes,
  customAttributes: input.customAttributes,
});

const reviewNeedsSync = (
  current: reviews.ProductReview,
  desired: reviews.ProductReview,
) =>
  !jsonEqual(current.productReviewId, desired.productReviewId) ||
  !jsonEqual(
    current.productReviewAttributes,
    desired.productReviewAttributes,
  ) ||
  !jsonEqual(
    normalizeCustomAttributes(current.customAttributes),
    normalizeCustomAttributes(desired.customAttributes),
  );

export const ProductReviewProvider = () =>
  Provider.succeed(ProductReview, {
    stables: ["name", "account", "productReviewId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAccount = olds?.account ?? output?.account;
      if (
        previousAccount !== undefined &&
        accountIdOf(news.account) !== accountIdOf(previousAccount)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.productReviewId ?? output?.productReviewId;
      if (
        previousId !== undefined &&
        news.productReviewId !== undefined &&
        news.productReviewId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const account = olds?.account ?? output?.account ?? "";
      const productReviewId = yield* toResourceId(
        id,
        olds?.productReviewId,
        output?.productReviewId,
      );
      const name =
        output?.name ?? productReviewNameOf(account, productReviewId);
      let existing = yield* getProductReview(name);
      if (existing === undefined && account) {
        existing = yield* findOwnedProductReview(id, account, productReviewId);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        account,
        olds?.dataSource ?? output?.dataSource,
      );
      return (yield* ownedByAlchemy(id, {
        customAttributes: existing.customAttributes,
        content: existing.productReviewAttributes?.content,
      }))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const accounts = yield* configuredAccountIds();
        const pages = yield* Effect.forEach(
          accounts,
          (account) => listProductReviewsAt(account),
          { concurrency: 4 },
        );
        const attrs = [];
        for (let i = 0; i < pages.length; i++) {
          const account = accounts[i]!;
          for (const review of pages[i] ?? []) {
            if (
              !hasAlchemyOwnership({
                customAttributes: review.customAttributes,
                content: review.productReviewAttributes?.content,
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
      const productReviewId = yield* toResourceId(
        id,
        news.productReviewId,
        output?.productReviewId,
      );
      const dataSource = dataSourceNameOf(account, news.dataSource);
      const name =
        output?.name ?? productReviewNameOf(account, productReviewId);
      const ownership = yield* createInternalLabels(id);
      const attributes = desiredAttributes({
        productReviewId,
        ownership,
        attrs: news.productReviewAttributes,
      });
      const customAttributes = stampCustomAttributes(
        ownership,
        news.customAttributes,
      );
      const desired = desiredBody({
        productReviewId,
        attributes,
        customAttributes,
      });

      let current = yield* getProductReview(name);
      if (current === undefined) {
        current = yield* findOwnedProductReview(id, account, productReviewId);
      }

      const upsert = () =>
        reviews
          .insertAccountsProductReviews({
            parent: parentOf(account),
            dataSource,
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => getProductReview(name)));

      if (current === undefined) {
        current = (yield* upsert()) ?? undefined;
      } else if (reviewNeedsSync(current, desired)) {
        current = (yield* upsert()) ?? current;
      }

      if (current === undefined) {
        return yield* new ProductReviewNotResolved({ name });
      }

      return toAttrs(current, account, dataSource);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* reviews
        .deleteAccountsProductReviews({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
