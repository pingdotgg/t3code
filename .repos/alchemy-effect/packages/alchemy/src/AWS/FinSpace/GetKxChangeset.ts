import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:GetKxChangeset` — reads one changeset of a kdb database in the bound environment — status, change requests, and error details — so ingestion pipelines can poll a changeset to `COMPLETED`.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.GetKxChangesetHttp)`.
 * @binding
 * @section Ingesting Data
 * @example Poll a Changeset
 * ```typescript
 * const getChangeset = yield* AWS.FinSpace.GetKxChangeset(kdb);
 *
 * const { status } = yield* getChangeset({
 *   databaseName: "ticks",
 *   changesetId,
 * });
 * ```
 */
export interface GetKxChangeset extends Binding.Service<
  GetKxChangeset,
  "AWS.FinSpace.GetKxChangeset",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.GetKxChangesetRequest, "environmentId">,
    ) => Effect.Effect<SVC.GetKxChangesetResponse, SVC.GetKxChangesetError>
  >
> {}
export const GetKxChangeset = Binding.Service<GetKxChangeset>(
  "AWS.FinSpace.GetKxChangeset",
);
