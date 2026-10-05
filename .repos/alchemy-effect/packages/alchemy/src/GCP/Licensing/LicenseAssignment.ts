import * as licensing from "@distilled.cloud/gcp/licensing_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  deleteAssignment,
  findAssignment,
  getAssignment,
  listAssignments,
  listCustomerId,
  listProductId,
  listSkuId,
  listUserId,
  normalizeCustomerId,
  replaceOnIdentity,
  sameText,
  sameUser,
} from "./internal.ts";

export type LicenseAssignmentProps = {
  /**
   * Product id (`Google-Apps`, `Google-Vault`, …). See Products and
   * SKUs in the Enterprise License Manager docs. Immutable — changing
   * it replaces the assignment.
   */
  productId: string;
  /**
   * Product SKU id (`Google-Apps-For-Business`, `1010020027`, …).
   * Reassigning to another SKU of the same product updates in place.
   */
  skuId: string;
  /**
   * User's primary email. Immutable — changing it replaces the
   * assignment. If the email changes in Admin Console, pass the new
   * address; the previous id is not a stable key.
   */
  userId: string;
  /**
   * Workspace customer id (`C0123abc` or `my_customer`). Used to look
   * up an existing assignment after a SKU change and by `list` when
   * matching env vars are set. Not sent on insert.
   */
  customerId?: string;
};

export type LicenseAssignment = Resource<
  "GCP.Licensing.LicenseAssignment",
  LicenseAssignmentProps,
  {
    /** Product id. */
    productId: string;
    /** Product SKU id. */
    skuId: string;
    /** User's primary email. */
    userId: string;
    /** Workspace customer id used for list lookups, if any. */
    customerId: string | undefined;
    /** Project id used when the assignment was reconciled. */
    project: string;
    /** Display name of the product. */
    productName: string | undefined;
    /** Display name of the SKU. */
    skuName: string | undefined;
    /** API self link. */
    selfLink: string | undefined;
    /** Resource kind (`licensing#licenseAssignment`). */
    kind: string | undefined;
    /** ETag of the assignment. */
    etags: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Workspace Enterprise License Manager assignment.
 *
 * Assignments have no labels or description, so Alchemy cannot stamp
 * ownership. `list` / nuke only returns rows when
 * `GOOGLE_LICENSE_CUSTOMER_ID` (or `GOOGLE_WORKSPACE_CUSTOMER_ID`),
 * `GOOGLE_LICENSE_PRODUCT_ID`, and `GOOGLE_LICENSE_USER_ID` are set, so
 * a Workspace domain is never bulk-revoked. Product and user are
 * identity — changing either replaces the assignment. SKU reassignment
 * within the same product updates in place via `licenseAssignments.patch`.
 *
 * Creating an assignment requires the
 * `https://www.googleapis.com/auth/apps.licensing` scope and a
 * Workspace admin on the customer.
 *
 * ### Creating an Assignment
 * **Example:** Assign a Workspace SKU
 * ```typescript
 * const seat = yield* GCP.Licensing.LicenseAssignment("Ada", {
 *   productId: "Google-Apps",
 *   skuId: "1010020027",
 *   userId: "ada@example.com",
 *   customerId: "my_customer",
 * });
 * ```
 *
 * ### Reassigning a SKU
 * **Example:** Move the user to another SKU of the same product
 * ```typescript
 * const seat = yield* GCP.Licensing.LicenseAssignment("Ada", {
 *   productId: "Google-Apps",
 *   skuId: "1010020028",
 *   userId: "ada@example.com",
 *   customerId: "my_customer",
 * });
 * ```
 *
 * @resource
 * @category Licensing
 */
export const LicenseAssignment = Resource<LicenseAssignment>(
  "GCP.Licensing.LicenseAssignment",
);

export class LicenseAssignmentNotResolved extends Data.TaggedError(
  "GCP.Licensing.LicenseAssignmentNotResolved",
)<{
  productId: string;
  skuId: string;
  userId: string;
}> {}

const toAttrs = (
  assignment: licensing.LicenseAssignment,
  project: string,
  customerId: string | undefined,
) => ({
  productId: assignment.productId ?? "",
  skuId: assignment.skuId ?? "",
  userId: assignment.userId ?? "",
  customerId,
  project,
  productName: assignment.productName,
  skuName: assignment.skuName,
  selfLink: assignment.selfLink,
  kind: assignment.kind,
  etags: assignment.etags,
});

const observeAssignment = (input: {
  productId: string;
  skuId: string;
  userId: string;
  customerId?: string;
  previousSkuId?: string;
}) =>
  Effect.gen(function* () {
    const bySku = yield* getAssignment(
      input.productId,
      input.skuId,
      input.userId,
    );
    if (bySku !== undefined) return bySku;
    if (
      input.previousSkuId !== undefined &&
      input.previousSkuId.length > 0 &&
      !sameText(input.previousSkuId, input.skuId)
    ) {
      const previous = yield* getAssignment(
        input.productId,
        input.previousSkuId,
        input.userId,
      );
      if (previous !== undefined) return previous;
    }
    return yield* findAssignment(
      input.productId,
      input.userId,
      input.customerId,
    );
  });

export const LicenseAssignmentProvider = () =>
  Provider.succeed(LicenseAssignment, {
    stables: ["productId", "userId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousProductId: olds?.productId ?? output?.productId,
        nextProductId: news.productId,
        previousUserId: olds?.userId ?? output?.userId,
        nextUserId: news.userId,
      });
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const productId = olds?.productId ?? output?.productId ?? "";
      const skuId = olds?.skuId ?? output?.skuId ?? "";
      const userId = olds?.userId ?? output?.userId ?? "";
      const customerId = normalizeCustomerId(
        olds?.customerId ?? output?.customerId ?? (yield* listCustomerId()),
      );
      const existing = yield* observeAssignment({
        productId,
        skuId,
        userId,
        customerId,
        previousSkuId: output?.skuId,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, customerId);
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const customerId = yield* listCustomerId();
        const productId = yield* listProductId();
        const userId = yield* listUserId();
        if (
          customerId === undefined ||
          productId === undefined ||
          userId === undefined
        ) {
          return [];
        }
        const env = yield* GcpEnvironment.current;
        const items = yield* listAssignments(
          productId,
          customerId,
          yield* listSkuId(),
        );
        return items
          .filter((item) => sameUser(item.userId, userId))
          .map((item) => toAttrs(item, env.project, customerId));
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const productId = news.productId;
      const skuId = news.skuId;
      const userId = news.userId;
      const customerId = normalizeCustomerId(
        news.customerId ?? output?.customerId ?? (yield* listCustomerId()),
      );

      let current = yield* observeAssignment({
        productId,
        skuId,
        userId,
        customerId,
        previousSkuId: output?.skuId,
      });

      if (current !== undefined && !sameUser(current.userId, userId)) {
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* licensing
          .insertLicenseAssignments({
            productId,
            skuId,
            body: { userId },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              observeAssignment({
                productId,
                skuId,
                userId,
                customerId,
                previousSkuId: output?.skuId,
              }),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new LicenseAssignmentNotResolved({
          productId,
          skuId,
          userId,
        });
      }

      const observedSku = current.skuId ?? skuId;
      if (!sameText(observedSku, skuId)) {
        current = yield* licensing.patchLicenseAssignments({
          productId,
          skuId: observedSku,
          userId: current.userId ?? userId,
          body: { skuId },
        });
      }

      return toAttrs(current, env.project, customerId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteAssignment(output.productId, output.skuId, output.userId);
    }),
  });
