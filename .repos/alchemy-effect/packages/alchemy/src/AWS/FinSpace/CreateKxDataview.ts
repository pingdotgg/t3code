import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:CreateKxDataview` — creates a dataview — a snapshot of a kdb database at a changeset, materialized onto volumes — in the bound environment.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.CreateKxDataviewHttp)`.
 * @binding
 * @section Managing Dataviews
 * @example Create a Dataview
 * ```typescript
 * const createDataview = yield* AWS.FinSpace.CreateKxDataview(kdb);
 *
 * yield* createDataview({
 *   databaseName: "ticks",
 *   dataviewName: "latest",
 *   azMode: "SINGLE",
 *   availabilityZoneId: "use1-az1",
 *   autoUpdate: true,
 *   clientToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface CreateKxDataview extends Binding.Service<
  CreateKxDataview,
  "AWS.FinSpace.CreateKxDataview",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.CreateKxDataviewRequest, "environmentId">,
    ) => Effect.Effect<SVC.CreateKxDataviewResponse, SVC.CreateKxDataviewError>
  >
> {}
export const CreateKxDataview = Binding.Service<CreateKxDataview>(
  "AWS.FinSpace.CreateKxDataview",
);
