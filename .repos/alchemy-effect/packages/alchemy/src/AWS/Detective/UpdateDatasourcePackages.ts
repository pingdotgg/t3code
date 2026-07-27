import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for `detective:UpdateDatasourcePackages`.
 *
 * Starts ingest for additional data source packages (e.g. `EKS_AUDIT`,
 * `ASFF_SECURITYHUB_FINDING`) on the behavior graph. Enabling a package is
 * irreversible through this API and affects Detective billing. The graph ARN
 * is injected from the bound {@link Graph}.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.UpdateDatasourcePackagesHttp)`.
 * @binding
 * @section Managing Data Source Packages
 * @example Enable EKS Audit Ingest
 * ```typescript
 * // init
 * const updateDatasourcePackages =
 *   yield* AWS.Detective.UpdateDatasourcePackages(graph);
 *
 * // runtime
 * yield* updateDatasourcePackages({ DatasourcePackages: ["EKS_AUDIT"] });
 * ```
 */
export interface UpdateDatasourcePackages extends Binding.Service<
  UpdateDatasourcePackages,
  "AWS.Detective.UpdateDatasourcePackages",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request: Omit<detective.UpdateDatasourcePackagesRequest, "GraphArn">,
    ) => Effect.Effect<
      detective.UpdateDatasourcePackagesResponse,
      detective.UpdateDatasourcePackagesError
    >
  >
> {}
export const UpdateDatasourcePackages =
  Binding.Service<UpdateDatasourcePackages>(
    "AWS.Detective.UpdateDatasourcePackages",
  );
