import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link ListCategories} — `instanceId` is injected from the bound Q App.
 */
export interface ListCategoriesRequest extends Omit<
  qapps.ListCategoriesInput,
  "instanceId"
> {}

/**
 * Runtime binding for `qapps:ListCategories`.
 *
 * Lists the library categories of the bound app's Q Business application environment instance. Provide the implementation with
 * `Effect.provide(AWS.QApps.ListCategoriesHttp)`.
 * @binding
 * @section Categories
 * @example List Categories
 * ```typescript
 * // init — bind the operation to the Q App
 * const listCategories = yield* AWS.QApps.ListCategories(app);
 *
 * // runtime
 * const result = yield* listCategories();
 * console.log(result.categories?.map((c) => c.title));
 * ```
 */
export interface ListCategories extends Binding.Service<
  ListCategories,
  "AWS.QApps.ListCategories",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request?: ListCategoriesRequest,
    ) => Effect.Effect<qapps.ListCategoriesOutput, qapps.ListCategoriesError>
  >
> {}

export const ListCategories = Binding.Service<ListCategories>(
  "AWS.QApps.ListCategories",
);
