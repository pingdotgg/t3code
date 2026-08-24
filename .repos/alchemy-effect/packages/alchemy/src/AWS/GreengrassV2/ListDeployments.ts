import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `greengrass:ListDeployments`.
 *
 * Enumerates the account's deployments, optionally filtered to one target
 * thing/thing group or to the latest revision per target — a fleet-wide view
 * of what is rolling out where. Provide the implementation with
 * `Effect.provide(AWS.GreengrassV2.ListDeploymentsHttp)`.
 * @binding
 * @section Monitoring Deployments
 * @example List The Latest Deployment Per Target
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listDeployments = yield* AWS.GreengrassV2.ListDeployments();
 *
 * // runtime
 * const { deployments } = yield* listDeployments({
 *   historyFilter: "LATEST_ONLY",
 * });
 * ```
 */
export interface ListDeployments extends Binding.Service<
  ListDeployments,
  "AWS.GreengrassV2.ListDeployments",
  () => Effect.Effect<
    (
      request?: greengrassv2.ListDeploymentsRequest,
    ) => Effect.Effect<
      greengrassv2.ListDeploymentsResponse,
      greengrassv2.ListDeploymentsError
    >
  >
> {}
export const ListDeployments = Binding.Service<ListDeployments>(
  "AWS.GreengrassV2.ListDeployments",
);
