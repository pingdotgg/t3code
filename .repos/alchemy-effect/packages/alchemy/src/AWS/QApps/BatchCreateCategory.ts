import type * as qapps from "@distilled.cloud/aws/qapps";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { QApp } from "./QApp.ts";

/**
 * Request for {@link BatchCreateCategory} — `instanceId` is injected from the bound Q App.
 */
export interface BatchCreateCategoryRequest extends Omit<
  qapps.BatchCreateCategoryInput,
  "instanceId"
> {}

/**
 * Runtime binding for `qapps:BatchCreateCategory`.
 *
 * Creates library categories that web-experience users use to tag and filter library items. Provide the implementation with
 * `Effect.provide(AWS.QApps.BatchCreateCategoryHttp)`.
 * @binding
 * @section Categories
 * @example Create Categories
 * ```typescript
 * // init — bind the operation to the Q App
 * const batchCreateCategory = yield* AWS.QApps.BatchCreateCategory(app);
 *
 * // runtime
 * yield* batchCreateCategory({
 *   categories: [{ title: "HR" }, { title: "Marketing" }],
 * });
 * ```
 */
export interface BatchCreateCategory extends Binding.Service<
  BatchCreateCategory,
  "AWS.QApps.BatchCreateCategory",
  (
    app: QApp,
  ) => Effect.Effect<
    (
      request: BatchCreateCategoryRequest,
    ) => Effect.Effect<
      qapps.BatchCreateCategoryResponse,
      qapps.BatchCreateCategoryError
    >
  >
> {}

export const BatchCreateCategory = Binding.Service<BatchCreateCategory>(
  "AWS.QApps.BatchCreateCategory",
);
