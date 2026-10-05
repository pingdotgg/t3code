import * as licensing from "@distilled.cloud/gcp/licensing_v1";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

export const DEFAULT_PRODUCT_ID = "Google-Apps";
export const DEFAULT_CUSTOMER_ID = "my_customer";

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameUser = (left: string | undefined, right: string | undefined) =>
  (left ?? "").trim().toLowerCase() === (right ?? "").trim().toLowerCase();

export const replaceOnIdentity = (input: {
  previousProductId?: string;
  nextProductId?: string;
  previousUserId?: string;
  nextUserId?: string;
}) => {
  if (
    input.previousProductId !== undefined &&
    input.nextProductId !== undefined &&
    !sameText(input.previousProductId, input.nextProductId)
  ) {
    return { action: "replace" as const, deleteFirst: true };
  }
  if (
    input.previousUserId !== undefined &&
    input.nextUserId !== undefined &&
    !sameUser(input.previousUserId, input.nextUserId)
  ) {
    return { action: "replace" as const, deleteFirst: true };
  }
  return undefined;
};

export const normalizeCustomerId = (value: string | undefined) => {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  return trimmed.startsWith("customers/")
    ? trimmed.slice("customers/".length)
    : trimmed;
};

/** Optional setting from the ConfigProvider (env by default). */
const optionalSetting = (key: string) =>
  Effect.gen(function* () {
    const value = Option.getOrUndefined(
      yield* Config.option(Config.String(key)),
    )?.trim();
    return value !== undefined && value.length > 0 ? value : undefined;
  });

/** Customer for `list` and the `customerId` default: `GOOGLE_LICENSE_CUSTOMER_ID`. */
export const listCustomerId = () =>
  Effect.gen(function* () {
    return normalizeCustomerId(
      (yield* optionalSetting("GOOGLE_LICENSE_CUSTOMER_ID")) ??
        (yield* optionalSetting("GOOGLE_WORKSPACE_CUSTOMER_ID")),
    );
  });

/** Product swept by `list`: `GOOGLE_LICENSE_PRODUCT_ID`. */
export const listProductId = () => optionalSetting("GOOGLE_LICENSE_PRODUCT_ID");

/** SKU swept by `list`: `GOOGLE_LICENSE_SKU_ID`. */
export const listSkuId = () => optionalSetting("GOOGLE_LICENSE_SKU_ID");

/** User whose assignments `list` returns: `GOOGLE_LICENSE_USER_ID`. */
export const listUserId = () => optionalSetting("GOOGLE_LICENSE_USER_ID");

const emptyList = <A>() => Effect.succeed([] as A[]);

export const getAssignment = (
  productId: string,
  skuId: string,
  userId: string,
) =>
  productId.length === 0 || skuId.length === 0 || userId.length === 0
    ? Effect.succeed(undefined)
    : licensing
        .getLicenseAssignments({
          productId,
          skuId,
          userId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listAssignments = (
  productId: string,
  customerId: string,
  skuId?: string,
) => {
  if (productId.length === 0 || customerId.length === 0) {
    return emptyList<licensing.LicenseAssignment>();
  }
  const pages =
    skuId !== undefined && skuId.length > 0
      ? licensing.listForProductAndSkuLicenseAssignments.pages({
          productId,
          skuId,
          customerId,
          maxResults: 100,
        })
      : licensing.listForProductLicenseAssignments.pages({
          productId,
          customerId,
          maxResults: 100,
        });
  return pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.items ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => emptyList<licensing.LicenseAssignment>()),
  );
};

export const findAssignment = (
  productId: string,
  userId: string,
  customerId: string | undefined,
  skuId?: string,
) =>
  Effect.gen(function* () {
    if (customerId === undefined || customerId.length === 0) {
      return undefined;
    }
    const items = yield* listAssignments(productId, customerId, skuId);
    return items.find((item) => sameUser(item.userId, userId));
  });

export const deleteAssignment = (
  productId: string,
  skuId: string,
  userId: string,
) =>
  productId.length === 0 || skuId.length === 0 || userId.length === 0
    ? Effect.void
    : licensing
        .deleteLicenseAssignments({
          productId,
          skuId,
          userId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
