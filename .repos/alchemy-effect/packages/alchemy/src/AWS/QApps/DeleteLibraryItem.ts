import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link DeleteLibraryItem} — `instanceId` is injected from the bound Q App.
 */
export interface DeleteLibraryItemRequest extends Omit<
  qapps.DeleteLibraryItemInput,
  "instanceId"
> {}

/**
 * Runtime binding for `qapps:DeleteLibraryItem`.
 *
 * Unpublishes a library item, removing the app from the instance's library. Provide the implementation with
 * `Effect.provide(AWS.QApps.DeleteLibraryItemHttp)`.
 * @binding
 * @section Library Items
 * @example Delete a Library Item
 * ```typescript
 * // init — bind the operation to the Q App
 * const deleteLibraryItem = yield* AWS.QApps.DeleteLibraryItem(app);
 *
 * // runtime
 * yield* deleteLibraryItem({ libraryItemId });
 * ```
 */
export interface DeleteLibraryItem extends Binding.Service<
  DeleteLibraryItem,
  "AWS.QApps.DeleteLibraryItem",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: DeleteLibraryItemRequest,
    ) => Effect.Effect<
      qapps.DeleteLibraryItemResponse,
      qapps.DeleteLibraryItemError
    >
  >
> {}

export const DeleteLibraryItem = Binding.Service<DeleteLibraryItem>(
  "AWS.QApps.DeleteLibraryItem",
);
