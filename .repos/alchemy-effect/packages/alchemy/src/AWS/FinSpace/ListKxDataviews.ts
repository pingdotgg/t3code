import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:ListKxDataviews` — lists the dataviews of a kdb database in the bound environment.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.ListKxDataviewsHttp)`.
 * @binding
 * @section Managing Dataviews
 * @example List a Database's Dataviews
 * ```typescript
 * const listDataviews = yield* AWS.FinSpace.ListKxDataviews(kdb);
 *
 * const { kxDataviews } = yield* listDataviews({ databaseName: "ticks" });
 * ```
 */
export interface ListKxDataviews extends Binding.Service<
  ListKxDataviews,
  "AWS.FinSpace.ListKxDataviews",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.ListKxDataviewsRequest, "environmentId">,
    ) => Effect.Effect<SVC.ListKxDataviewsResponse, SVC.ListKxDataviewsError>
  >
> {}
export const ListKxDataviews = Binding.Service<ListKxDataviews>(
  "AWS.FinSpace.ListKxDataviews",
);
