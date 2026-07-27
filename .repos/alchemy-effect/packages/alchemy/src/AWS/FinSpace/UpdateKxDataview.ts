import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:UpdateKxDataview` — advances a dataview of a kdb database in the bound environment to a new changeset (or new segment configurations) — how ingestion pipelines roll fresh data out to readers.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.UpdateKxDataviewHttp)`.
 * @binding
 * @section Managing Dataviews
 * @example Advance a Dataview to a Changeset
 * ```typescript
 * const updateDataview = yield* AWS.FinSpace.UpdateKxDataview(kdb);
 *
 * yield* updateDataview({
 *   databaseName: "ticks",
 *   dataviewName: "latest",
 *   changesetId,
 *   clientToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface UpdateKxDataview extends Binding.Service<
  UpdateKxDataview,
  "AWS.FinSpace.UpdateKxDataview",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.UpdateKxDataviewRequest, "environmentId">,
    ) => Effect.Effect<SVC.UpdateKxDataviewResponse, SVC.UpdateKxDataviewError>
  >
> {}
export const UpdateKxDataview = Binding.Service<UpdateKxDataview>(
  "AWS.FinSpace.UpdateKxDataview",
);
