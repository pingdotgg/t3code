import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link BatchUpdateCategory} — `instanceId` is injected from the bound Q App.
 */
export interface BatchUpdateCategoryRequest extends Omit<
  qapps.BatchUpdateCategoryInput,
  "instanceId"
> {}

/**
 * Runtime binding for `qapps:BatchUpdateCategory`.
 *
 * Renames or recolors existing library categories. Provide the implementation with
 * `Effect.provide(AWS.QApps.BatchUpdateCategoryHttp)`.
 * @binding
 * @section Categories
 * @example Rename a Category
 * ```typescript
 * // init — bind the operation to the Q App
 * const batchUpdateCategory = yield* AWS.QApps.BatchUpdateCategory(app);
 *
 * // runtime
 * yield* batchUpdateCategory({
 *   categories: [{ id: categoryId, title: "People Ops" }],
 * });
 * ```
 */
export interface BatchUpdateCategory extends Binding.Service<
  BatchUpdateCategory,
  "AWS.QApps.BatchUpdateCategory",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: BatchUpdateCategoryRequest,
    ) => Effect.Effect<
      qapps.BatchUpdateCategoryResponse,
      qapps.BatchUpdateCategoryError
    >
  >
> {}

export const BatchUpdateCategory = Binding.Service<BatchUpdateCategory>(
  "AWS.QApps.BatchUpdateCategory",
);
