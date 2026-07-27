import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:ListKxDatabases` — lists the kdb databases of the bound environment.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.ListKxDatabasesHttp)`.
 * @binding
 * @section Reading Databases
 * @example List Databases
 * ```typescript
 * const listDatabases = yield* AWS.FinSpace.ListKxDatabases(kdb);
 *
 * const { kxDatabases } = yield* listDatabases();
 * ```
 */
export interface ListKxDatabases extends Binding.Service<
  ListKxDatabases,
  "AWS.FinSpace.ListKxDatabases",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListKxDatabasesRequest, "environmentId">,
    ) => Effect.Effect<SVC.ListKxDatabasesResponse, SVC.ListKxDatabasesError>
  >
> {}
export const ListKxDatabases = Binding.Service<ListKxDatabases>(
  "AWS.FinSpace.ListKxDatabases",
);
