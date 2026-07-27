import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:GetKxDatabase` — reads one kdb database of the bound environment — including `lastCompletedChangesetId`, the anchor ingestion pipelines use to advance dataviews.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.GetKxDatabaseHttp)`.
 * @binding
 * @section Reading Databases
 * @example Read the Latest Changeset Id
 * ```typescript
 * const getDatabase = yield* AWS.FinSpace.GetKxDatabase(kdb);
 *
 * const { lastCompletedChangesetId } = yield* getDatabase({
 *   databaseName: "ticks",
 * });
 * ```
 */
export interface GetKxDatabase extends Binding.Service<
  GetKxDatabase,
  "AWS.FinSpace.GetKxDatabase",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.GetKxDatabaseRequest, "environmentId">,
    ) => Effect.Effect<SVC.GetKxDatabaseResponse, SVC.GetKxDatabaseError>
  >
> {}
export const GetKxDatabase = Binding.Service<GetKxDatabase>(
  "AWS.FinSpace.GetKxDatabase",
);
