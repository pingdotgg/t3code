import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link BatchDeleteCategory} — `instanceId` is injected from the bound Q App.
 */
export interface BatchDeleteCategoryRequest extends Omit<
  qapps.BatchDeleteCategoryInput,
  "instanceId"
> {}

/**
 * Runtime binding for `qapps:BatchDeleteCategory`.
 *
 * Deletes library categories by id. Provide the implementation with
 * `Effect.provide(AWS.QApps.BatchDeleteCategoryHttp)`.
 * @binding
 * @section Categories
 * @example Delete Categories
 * ```typescript
 * // init — bind the operation to the Q App
 * const batchDeleteCategory = yield* AWS.QApps.BatchDeleteCategory(app);
 *
 * // runtime
 * yield* batchDeleteCategory({ categories: [categoryId] });
 * ```
 */
export interface BatchDeleteCategory extends Binding.Service<
  BatchDeleteCategory,
  "AWS.QApps.BatchDeleteCategory",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: BatchDeleteCategoryRequest,
    ) => Effect.Effect<
      qapps.BatchDeleteCategoryResponse,
      qapps.BatchDeleteCategoryError
    >
  >
> {}

export const BatchDeleteCategory = Binding.Service<BatchDeleteCategory>(
  "AWS.QApps.BatchDeleteCategory",
);
