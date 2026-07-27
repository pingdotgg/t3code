import type * as devopsguru from "@distilled.cloud/aws/devops-guru";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `devops-guru:DescribeOrganizationResourceCollectionHealth`.
 *
 * Returns per-CloudFormation-stack (or per-tag/per-service) insight counts across the organization's accounts.
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.DescribeOrganizationResourceCollectionHealthHttp)`.
 * @binding
 * @section Organization Visibility
 * @example Read Per-Stack Health Across Accounts
 * ```typescript
 * // init — account-level binding, no resource argument
 * const describeOrganizationResourceCollectionHealth = yield* AWS.DevOpsGuru.DescribeOrganizationResourceCollectionHealth();
 *
 * // runtime
 * const page = yield* describeOrganizationResourceCollectionHealth({
 *   OrganizationResourceCollectionType: "AWS_CLOUD_FORMATION",
 * });
 * yield* Effect.log(`stacks analyzed: ${page.CloudFormation?.length}`);
 * ```
 */
export interface DescribeOrganizationResourceCollectionHealth extends Binding.Service<
  DescribeOrganizationResourceCollectionHealth,
  "AWS.DevOpsGuru.DescribeOrganizationResourceCollectionHealth",
  () => Effect.Effect<
    (
      request: devopsguru.DescribeOrganizationResourceCollectionHealthRequest,
    ) => Effect.Effect<
      devopsguru.DescribeOrganizationResourceCollectionHealthResponse,
      devopsguru.DescribeOrganizationResourceCollectionHealthError
    >
  >
> {}
export const DescribeOrganizationResourceCollectionHealth =
  Binding.Service<DescribeOrganizationResourceCollectionHealth>(
    "AWS.DevOpsGuru.DescribeOrganizationResourceCollectionHealth",
  );
