import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for `detective:DescribeOrganizationConfiguration`.
 *
 * Reads whether new organization accounts are auto-enabled as members of
 * the behavior graph. Callable only by the organization's delegated
 * Detective administrator account. The graph ARN is injected from the bound
 * {@link Graph}.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.DescribeOrganizationConfigurationHttp)`.
 * @binding
 * @section Organization Administration
 * @example Check Auto-Enable
 * ```typescript
 * // init
 * const describeOrganizationConfiguration =
 *   yield* AWS.Detective.DescribeOrganizationConfiguration(graph);
 *
 * // runtime
 * const { AutoEnable } = yield* describeOrganizationConfiguration();
 * ```
 */
export interface DescribeOrganizationConfiguration extends Binding.Service<
  DescribeOrganizationConfiguration,
  "AWS.Detective.DescribeOrganizationConfiguration",
  (
    graph: Graph,
  ) => Effect.Effect<
    () => Effect.Effect<
      detective.DescribeOrganizationConfigurationResponse,
      detective.DescribeOrganizationConfigurationError
    >
  >
> {}
export const DescribeOrganizationConfiguration =
  Binding.Service<DescribeOrganizationConfiguration>(
    "AWS.Detective.DescribeOrganizationConfiguration",
  );
