import type * as SVC from "@distilled.cloud/aws/finspace";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:UpdateKxClusterDatabases` — remounts a running cluster's databases at new changesets (with rolling or no-restart deployment) — how ingestion pipelines roll fresh data out to clusters that don't read through dataviews.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.UpdateKxClusterDatabasesHttp)`.
 * @binding
 * @section Deploying to Clusters
 * @example Roll a Cluster to a New Changeset
 * ```typescript
 * const updateClusterDatabases = yield* AWS.FinSpace.UpdateKxClusterDatabases(kdb);
 *
 * yield* updateClusterDatabases({
 *   clusterName: "hdb",
 *   databases: [{ databaseName: "ticks", changesetId }],
 *   deploymentConfiguration: { deploymentStrategy: "NO_RESTART" },
 *   clientToken: crypto.randomUUID(),
 * });
 * ```
 */
export interface UpdateKxClusterDatabases extends Binding.Service<
  UpdateKxClusterDatabases,
  "AWS.FinSpace.UpdateKxClusterDatabases",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.UpdateKxClusterDatabasesRequest, "environmentId">,
    ) => Effect.Effect<
      SVC.UpdateKxClusterDatabasesResponse,
      SVC.UpdateKxClusterDatabasesError
    >
  >
> {}
export const UpdateKxClusterDatabases =
  Binding.Service<UpdateKxClusterDatabases>(
    "AWS.FinSpace.UpdateKxClusterDatabases",
  );
