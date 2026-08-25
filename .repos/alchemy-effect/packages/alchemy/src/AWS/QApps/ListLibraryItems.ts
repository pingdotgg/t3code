import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link ListLibraryItems} — `instanceId` is injected from the bound Q App.
 */
export interface ListLibraryItemsRequest extends Omit<
  qapps.ListLibraryItemsInput,
  "instanceId"
> {}

/**
 * Runtime binding for `qapps:ListLibraryItems`.
 *
 * Lists the library items published in the bound app's Q Business application environment instance. Provide the implementation with
 * `Effect.provide(AWS.QApps.ListLibraryItemsHttp)`.
 * @binding
 * @section Library Items
 * @example List Library Items
 * ```typescript
 * // init — bind the operation to the Q App
 * const listLibraryItems = yield* AWS.QApps.ListLibraryItems(app);
 *
 * // runtime
 * const page = yield* listLibraryItems({ limit: 25 });
 * console.log(page.libraryItems?.length);
 * ```
 */
export interface ListLibraryItems extends Binding.Service<
  ListLibraryItems,
  "AWS.QApps.ListLibraryItems",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request?: ListLibraryItemsRequest,
    ) => Effect.Effect<
      qapps.ListLibraryItemsOutput,
      qapps.ListLibraryItemsError
    >
  >
> {}

export const ListLibraryItems = Binding.Service<ListLibraryItems>(
  "AWS.QApps.ListLibraryItems",
);
