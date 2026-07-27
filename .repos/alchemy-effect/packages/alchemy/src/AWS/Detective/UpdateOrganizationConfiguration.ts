import type * as detective from "@distilled.cloud/aws/detective";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for `detective:UpdateOrganizationConfiguration`.
 *
 * Toggles auto-enable for new organization accounts on the behavior graph.
 * Callable only by the organization's delegated Detective administrator
 * account. The graph ARN is injected from the bound {@link Graph}.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.UpdateOrganizationConfigurationHttp)`.
 * @binding
 * @section Organization Administration
 * @example Auto-Enable New Organization Accounts
 * ```typescript
 * // init
 * const updateOrganizationConfiguration =
 *   yield* AWS.Detective.UpdateOrganizationConfiguration(graph);
 *
 * // runtime
 * yield* updateOrganizationConfiguration({ AutoEnable: true });
 * ```
 */
export interface UpdateOrganizationConfiguration extends Binding.Service<
  UpdateOrganizationConfiguration,
  "AWS.Detective.UpdateOrganizationConfiguration",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request?: Omit<
        detective.UpdateOrganizationConfigurationRequest,
        "GraphArn"
      >,
    ) => Effect.Effect<
      detective.UpdateOrganizationConfigurationResponse,
      detective.UpdateOrganizationConfigurationError
    >
  >
> {}
export const UpdateOrganizationConfiguration =
  Binding.Service<UpdateOrganizationConfiguration>(
    "AWS.Detective.UpdateOrganizationConfiguration",
  );
