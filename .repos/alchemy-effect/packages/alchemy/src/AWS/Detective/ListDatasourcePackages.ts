import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for `detective:ListDatasourcePackages`.
 *
 * Lists the behavior graph's data source packages (core CloudTrail/VPC Flow,
 * EKS audit, ASFF findings) and their ingest state — audit what Detective is
 * actually ingesting. The graph ARN is injected from the bound {@link Graph}.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.ListDatasourcePackagesHttp)`.
 * @binding
 * @section Managing Data Source Packages
 * @example Audit Ingested Data Sources
 * ```typescript
 * // init
 * const listDatasourcePackages =
 *   yield* AWS.Detective.ListDatasourcePackages(graph);
 *
 * // runtime
 * const { DatasourcePackages } = yield* listDatasourcePackages();
 * ```
 */
export interface ListDatasourcePackages extends Binding.Service<
  ListDatasourcePackages,
  "AWS.Detective.ListDatasourcePackages",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request?: Omit<detective.ListDatasourcePackagesRequest, "GraphArn">,
    ) => Effect.Effect<
      detective.ListDatasourcePackagesResponse,
      detective.ListDatasourcePackagesError
    >
  >
> {}
export const ListDatasourcePackages = Binding.Service<ListDatasourcePackages>(
  "AWS.Detective.ListDatasourcePackages",
);
