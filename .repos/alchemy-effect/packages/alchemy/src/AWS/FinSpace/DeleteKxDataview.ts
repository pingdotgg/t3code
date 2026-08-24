import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:DeleteKxDataview` — deletes a dataview of a kdb database in the bound environment.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.DeleteKxDataviewHttp)`.
 * @binding
 * @section Managing Dataviews
 * @example Delete a Dataview
 * ```typescript
 * const deleteDataview = yield* AWS.FinSpace.DeleteKxDataview(kdb);
 *
 * yield* deleteDataview({
 *   databaseName: "ticks",
 *   dataviewName: "latest",
 *   clientToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface DeleteKxDataview extends Binding.Service<
  DeleteKxDataview,
  "AWS.FinSpace.DeleteKxDataview",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.DeleteKxDataviewRequest, "environmentId">,
    ) => Effect.Effect<SVC.DeleteKxDataviewResponse, SVC.DeleteKxDataviewError>
  >
> {}
export const DeleteKxDataview = Binding.Service<DeleteKxDataview>(
  "AWS.FinSpace.DeleteKxDataview",
);
