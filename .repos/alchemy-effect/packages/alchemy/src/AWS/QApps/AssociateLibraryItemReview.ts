import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link AssociateLibraryItemReview} — `instanceId` is injected from the bound Q App.
 */
export interface AssociateLibraryItemReviewRequest extends Omit<
  qapps.AssociateLibraryItemReviewInput,
  "instanceId"
> {}

/**
 * Runtime binding for `qapps:AssociateLibraryItemReview`.
 *
 * Upvotes a library item as the calling identity. Provide the implementation with
 * `Effect.provide(AWS.QApps.AssociateLibraryItemReviewHttp)`.
 * @binding
 * @section Library Items
 * @example Upvote a Library Item
 * ```typescript
 * // init — bind the operation to the Q App
 * const associateLibraryItemReview = yield* AWS.QApps.AssociateLibraryItemReview(app);
 *
 * // runtime
 * yield* associateLibraryItemReview({ libraryItemId });
 * ```
 */
export interface AssociateLibraryItemReview extends Binding.Service<
  AssociateLibraryItemReview,
  "AWS.QApps.AssociateLibraryItemReview",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: AssociateLibraryItemReviewRequest,
    ) => Effect.Effect<
      qapps.AssociateLibraryItemReviewResponse,
      qapps.AssociateLibraryItemReviewError
    >
  >
> {}

export const AssociateLibraryItemReview =
  Binding.Service<AssociateLibraryItemReview>(
    "AWS.QApps.AssociateLibraryItemReview",
  );
