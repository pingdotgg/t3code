import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link GetLibraryItem} — `instanceId` is injected from the bound Q App.
 */
export interface GetLibraryItemRequest extends Omit<
  qapps.GetLibraryItemInput,
  "instanceId"
> {}

/**
 * Runtime binding for `qapps:GetLibraryItem`.
 *
 * Retrieves a library item — its published app version, categories, status, and rating counts. Provide the implementation with
 * `Effect.provide(AWS.QApps.GetLibraryItemHttp)`.
 * @binding
 * @section Library Items
 * @example Read a Library Item
 * ```typescript
 * // init — bind the operation to the Q App
 * const getLibraryItem = yield* AWS.QApps.GetLibraryItem(app);
 *
 * // runtime
 * const item = yield* getLibraryItem({ libraryItemId });
 * console.log(item.ratingCount);
 * ```
 */
export interface GetLibraryItem extends Binding.Service<
  GetLibraryItem,
  "AWS.QApps.GetLibraryItem",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: GetLibraryItemRequest,
    ) => Effect.Effect<qapps.GetLibraryItemOutput, qapps.GetLibraryItemError>
  >
> {}

export const GetLibraryItem = Binding.Service<GetLibraryItem>(
  "AWS.QApps.GetLibraryItem",
);
