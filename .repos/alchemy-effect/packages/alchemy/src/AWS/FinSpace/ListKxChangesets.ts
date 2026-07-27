import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:ListKxChangesets` — lists the changesets of a kdb database in the bound environment, newest first.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.ListKxChangesetsHttp)`.
 * @binding
 * @section Ingesting Data
 * @example List a Database's Changesets
 * ```typescript
 * const listChangesets = yield* AWS.FinSpace.ListKxChangesets(kdb);
 *
 * const { kxChangesets } = yield* listChangesets({ databaseName: "ticks" });
 * ```
 */
export interface ListKxChangesets extends Binding.Service<
  ListKxChangesets,
  "AWS.FinSpace.ListKxChangesets",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.ListKxChangesetsRequest, "environmentId">,
    ) => Effect.Effect<SVC.ListKxChangesetsResponse, SVC.ListKxChangesetsError>
  >
> {}
export const ListKxChangesets = Binding.Service<ListKxChangesets>(
  "AWS.FinSpace.ListKxChangesets",
);
