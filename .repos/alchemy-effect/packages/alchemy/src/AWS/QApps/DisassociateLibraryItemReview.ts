import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link DisassociateLibraryItemReview} — `instanceId` is injected from the bound Q App.
 */
export interface DisassociateLibraryItemReviewRequest extends Omit<
  qapps.DisassociateLibraryItemReviewInput,
  "instanceId"
> {}

/**
 * Runtime binding for `qapps:DisassociateLibraryItemReview`.
 *
 * Removes the calling identity's upvote from a library item. Provide the implementation with
 * `Effect.provide(AWS.QApps.DisassociateLibraryItemReviewHttp)`.
 * @binding
 * @section Library Items
 * @example Remove an Upvote
 * ```typescript
 * // init — bind the operation to the Q App
 * const disassociateLibraryItemReview = yield* AWS.QApps.DisassociateLibraryItemReview(app);
 *
 * // runtime
 * yield* disassociateLibraryItemReview({ libraryItemId });
 * ```
 */
export interface DisassociateLibraryItemReview extends Binding.Service<
  DisassociateLibraryItemReview,
  "AWS.QApps.DisassociateLibraryItemReview",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: DisassociateLibraryItemReviewRequest,
    ) => Effect.Effect<
      qapps.DisassociateLibraryItemReviewResponse,
      qapps.DisassociateLibraryItemReviewError
    >
  >
> {}

export const DisassociateLibraryItemReview =
  Binding.Service<DisassociateLibraryItemReview>(
    "AWS.QApps.DisassociateLibraryItemReview",
  );
