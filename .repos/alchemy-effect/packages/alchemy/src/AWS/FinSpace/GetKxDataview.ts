import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:GetKxDataview` — reads one dataview of a kdb database in the bound environment — status, active versions, and segment configurations.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.GetKxDataviewHttp)`.
 * @binding
 * @section Managing Dataviews
 * @example Poll a Dataview
 * ```typescript
 * const getDataview = yield* AWS.FinSpace.GetKxDataview(kdb);
 *
 * const { status } = yield* getDataview({
 *   databaseName: "ticks",
 *   dataviewName: "latest",
 * });
 * ```
 */
export interface GetKxDataview extends Binding.Service<
  GetKxDataview,
  "AWS.FinSpace.GetKxDataview",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.GetKxDataviewRequest, "environmentId">,
    ) => Effect.Effect<SVC.GetKxDataviewResponse, SVC.GetKxDataviewError>
  >
> {}
export const GetKxDataview = Binding.Service<GetKxDataview>(
  "AWS.FinSpace.GetKxDataview",
);
