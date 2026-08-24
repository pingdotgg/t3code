import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link CreateLibraryItem} — `instanceId` and `appId` are injected from the bound Q App.
 */
export interface CreateLibraryItemRequest extends Omit<
  qapps.CreateLibraryItemInput,
  "instanceId" | "appId"
> {}

/**
 * Runtime binding for `qapps:CreateLibraryItem`.
 *
 * Publishes a version of the bound Q App into the instance's library so other users can discover and run it. Provide the implementation with
 * `Effect.provide(AWS.QApps.CreateLibraryItemHttp)`.
 * @binding
 * @section Library Items
 * @example Publish the App to the Library
 * ```typescript
 * // init — bind the operation to the Q App
 * const createLibraryItem = yield* AWS.QApps.CreateLibraryItem(app);
 *
 * // runtime
 * const item = yield* createLibraryItem({
 *   appVersion: 1,
 *   categories: [categoryId],
 * });
 * console.log(item.libraryItemId);
 * ```
 */
export interface CreateLibraryItem extends Binding.Service<
  CreateLibraryItem,
  "AWS.QApps.CreateLibraryItem",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: CreateLibraryItemRequest,
    ) => Effect.Effect<
      qapps.CreateLibraryItemOutput,
      qapps.CreateLibraryItemError
    >
  >
> {}

export const CreateLibraryItem = Binding.Service<CreateLibraryItem>(
  "AWS.QApps.CreateLibraryItem",
);
