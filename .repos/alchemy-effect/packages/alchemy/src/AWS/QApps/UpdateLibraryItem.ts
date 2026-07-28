import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link UpdateLibraryItem} — `instanceId` is injected from the bound Q App.
 */
export interface UpdateLibraryItemRequest extends Omit<
  qapps.UpdateLibraryItemInput,
  "instanceId"
> {}

/**
 * Runtime binding for `qapps:UpdateLibraryItem`.
 *
 * Updates a library item's publication status or categories. Provide the implementation with
 * `Effect.provide(AWS.QApps.UpdateLibraryItemHttp)`.
 * @binding
 * @section Library Items
 * @example Disable a Library Item
 * ```typescript
 * // init — bind the operation to the Q App
 * const updateLibraryItem = yield* AWS.QApps.UpdateLibraryItem(app);
 *
 * // runtime
 * yield* updateLibraryItem({ libraryItemId, status: "DISABLED" });
 * ```
 */
export interface UpdateLibraryItem extends Binding.Service<
  UpdateLibraryItem,
  "AWS.QApps.UpdateLibraryItem",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: UpdateLibraryItemRequest,
    ) => Effect.Effect<
      qapps.UpdateLibraryItemOutput,
      qapps.UpdateLibraryItemError
    >
  >
> {}

export const UpdateLibraryItem = Binding.Service<UpdateLibraryItem>(
  "AWS.QApps.UpdateLibraryItem",
);
