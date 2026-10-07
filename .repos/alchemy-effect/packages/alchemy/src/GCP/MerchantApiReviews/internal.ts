import * as reviews from "@distilled.cloud/gcp/merchantapi_reviews_v1beta";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

/** Optional deploy-time setting from the ConfigProvider (env by default). */
const optionalSetting = (key: string) =>
  Effect.gen(function* () {
    const value = yield* Config.option(Config.String(key));
    return Option.getOrUndefined(value)?.trim() || undefined;
  });

export const MAX_ID_LENGTH = 64;
export const MAX_CONTENT_LENGTH = 16_000;
export const DEFAULT_REVIEW_TIME = "2020-01-01T00:00:00Z";
export const DEFAULT_LANGUAGE = "en";
export const DEFAULT_COUNTRY = "US";

export type ReviewCustomAttribute = {
  name?: string;
  value?: string;
  groupValues?: ReviewCustomAttribute[];
};

export type ReviewLinkProps = {
  link?: string;
  type?: reviews.ReviewLinkTypeEnum | (string & {});
};

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = markerOf(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_CONTENT_LENGTH,
): string => {
  const marker = fitMarker(labels, Math.min(800, maxLength));
  const trimmed = text?.trim();
  const combined =
    trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
  return combined.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

const labelsMatch = (
  expected: Record<string, string>,
  labels: Record<string, string>,
) =>
  prefixMatch(
    expected[alchemyLabelKeys.stack] ?? "",
    labels[alchemyLabelKeys.stack] ?? "",
  ) &&
  prefixMatch(
    expected[alchemyLabelKeys.stage] ?? "",
    labels[alchemyLabelKeys.stage] ?? "",
  ) &&
  prefixMatch(
    expected[alchemyLabelKeys.id] ?? "",
    labels[alchemyLabelKeys.id] ?? "",
  );

export const stampCustomAttributes = (
  labels: Record<string, string>,
  custom: readonly ReviewCustomAttribute[] | undefined,
): reviews.CustomAttribute[] => {
  const user = (custom ?? []).filter(
    (attr) => attr.name === undefined || !attr.name.startsWith("alchemy-"),
  );
  return [
    ...user,
    {
      name: alchemyLabelKeys.stack,
      value: labels[alchemyLabelKeys.stack],
    },
    {
      name: alchemyLabelKeys.stage,
      value: labels[alchemyLabelKeys.stage],
    },
    {
      name: alchemyLabelKeys.id,
      value: labels[alchemyLabelKeys.id],
    },
  ];
};

export const stripCustomAttributes = (
  custom: readonly ReviewCustomAttribute[] | undefined,
): ReviewCustomAttribute[] =>
  (custom ?? []).filter(
    (attr) => attr.name === undefined || !attr.name.startsWith("alchemy-"),
  );

export const ownershipFromCustomAttributes = (
  custom: readonly ReviewCustomAttribute[] | undefined,
): Record<string, string> => {
  const labels: Record<string, string> = {};
  for (const attr of custom ?? []) {
    if (attr.name?.startsWith("alchemy-") && attr.value) {
      labels[attr.name] = attr.value;
    }
  }
  return labels;
};

export const hasCustomOwnership = (
  custom: readonly ReviewCustomAttribute[] | undefined,
) => Object.keys(ownershipFromCustomAttributes(custom)).length > 0;

export const ownedByAlchemy = (
  id: string,
  input: {
    customAttributes?: readonly ReviewCustomAttribute[];
    content?: string;
  },
) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const fromCustom = ownershipFromCustomAttributes(input.customAttributes);
    if (Object.keys(fromCustom).length > 0) {
      if (yield* hasAlchemyLabels(id, fromCustom)) return true;
      if (labelsMatch(expected, fromCustom)) return true;
    }
    const parsed = parseOwnership(input.content);
    if (!hasOwnershipMarker(input.content)) return false;
    if (yield* hasAlchemyLabels(id, parsed.labels)) return true;
    return labelsMatch(expected, parsed.labels);
  });

export const hasAlchemyOwnership = (input: {
  customAttributes?: readonly ReviewCustomAttribute[];
  content?: string;
}) =>
  hasCustomOwnership(input.customAttributes) ||
  hasOwnershipMarker(input.content);

export const accountIdOf = (account: string) =>
  account.replace(/^accounts\//, "").split("/")[0] ?? account;

export const parentOf = (account: string) => `accounts/${accountIdOf(account)}`;

export const dataSourceNameOf = (account: string, dataSource: string) => {
  if (dataSource.includes("/dataSources/")) return dataSource;
  const id = dataSource.replace(/^dataSources\//, "");
  return `${parentOf(account)}/dataSources/${id}`;
};

export const merchantReviewNameOf = (account: string, reviewId: string) =>
  `${parentOf(account)}/merchantReviews/${reviewId}`;

export const productReviewNameOf = (account: string, reviewId: string) =>
  `${parentOf(account)}/productReviews/${reviewId}`;

export const lastSegment = (name: string) => {
  const trimmed = name.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify([...(left ?? [])].slice().sort()) ===
  JSON.stringify([...(right ?? [])].slice().sort());

export const normalizeCustomAttributes = (
  custom: readonly ReviewCustomAttribute[] | undefined,
) =>
  [...(custom ?? [])]
    .map((attr) => ({
      name: attr.name,
      value: attr.value,
      groupValues: attr.groupValues,
    }))
    .sort((left, right) => (left.name ?? "").localeCompare(right.name ?? ""));

export const toResourceId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ID_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    return /^[a-z]/.test(generated)
      ? generated
      : `r${generated}`.slice(0, maxLength);
  });

/** Merchant Center accounts named in the Merchant API settings (for `list`). */
export const configuredAccountIds = () =>
  Effect.gen(function* () {
    const ids = new Set<string>();
    for (const key of [
      "GCP_MERCHANTAPI_ACCOUNT_ID",
      "GCP_CONTENT_MERCHANT_ID",
    ]) {
      const value = yield* optionalSetting(key);
      if (value) ids.add(accountIdOf(value));
    }
    return [...ids];
  });

const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const getMerchantReview = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : reviews
        .getAccountsMerchantReviews({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const getProductReview = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : reviews
        .getAccountsProductReviews({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listMerchantReviewsAt = (account: string) =>
  account.length === 0
    ? Effect.succeed([] as reviews.MerchantReview[])
    : collectPages(
        reviews.listAccountsMerchantReviews.pages({
          parent: parentOf(account),
          pageSize: 250,
        }),
        (page) => page.merchantReviews,
      ).pipe(
        Effect.catchTag("NotFound", () =>
          Effect.succeed([] as reviews.MerchantReview[]),
        ),
      );

export const listProductReviewsAt = (account: string) =>
  account.length === 0
    ? Effect.succeed([] as reviews.ProductReview[])
    : collectPages(
        reviews.listAccountsProductReviews.pages({
          parent: parentOf(account),
          pageSize: 250,
        }),
        (page) => page.productReviews,
      ).pipe(
        Effect.catchTag("NotFound", () =>
          Effect.succeed([] as reviews.ProductReview[]),
        ),
      );

export const findOwnedMerchantReview = (
  id: string,
  account: string,
  merchantReviewId?: string,
) =>
  Effect.gen(function* () {
    const listed = yield* listMerchantReviewsAt(account);
    for (const review of listed) {
      if (merchantReviewId && review.merchantReviewId !== merchantReviewId) {
        continue;
      }
      if (
        yield* ownedByAlchemy(id, {
          customAttributes: review.customAttributes,
          content: review.merchantReviewAttributes?.content,
        })
      ) {
        return review;
      }
    }
    return undefined;
  });

export const findOwnedProductReview = (
  id: string,
  account: string,
  productReviewId?: string,
) =>
  Effect.gen(function* () {
    const listed = yield* listProductReviewsAt(account);
    for (const review of listed) {
      if (productReviewId && review.productReviewId !== productReviewId) {
        continue;
      }
      if (
        yield* ownedByAlchemy(id, {
          customAttributes: review.customAttributes,
          content: review.productReviewAttributes?.content,
        })
      ) {
        return review;
      }
    }
    return undefined;
  });
