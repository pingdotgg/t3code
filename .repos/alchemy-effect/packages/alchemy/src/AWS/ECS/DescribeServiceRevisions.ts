import type * as ECS from "@distilled.cloud/aws/ecs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

export interface DescribeServiceRevisionsRequest
  extends ECS.DescribeServiceRevisionsRequest {}

/**
 * Runtime binding for `ecs:DescribeServiceRevisions`.
 *
 * Bind this operation to a `Service` inside a function runtime to get a
 * callable that describes the bound service's revisions — the immutable
 * task-definition + configuration snapshots that deployments roll between.
 * The host is granted `ecs:DescribeServiceRevisions` on the service's
 * revisions (revision ARNs come from deployment describe/list responses).
 * @binding
 * @section Service Deployments
 * @example Inspect a Target Revision
 * ```typescript
 * const describeServiceRevisions =
 *   yield* AWS.ECS.DescribeServiceRevisions(service);
 *
 * const response = yield* describeServiceRevisions({
 *   serviceRevisionArns: [revisionArn],
 * });
 * const taskDefinition = response.serviceRevisions?.[0]?.taskDefinition;
 * ```
 */
export interface DescribeServiceRevisions extends Binding.Service<
  DescribeServiceRevisions,
  "AWS.ECS.DescribeServiceRevisions",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request: DescribeServiceRevisionsRequest,
    ) => Effect.Effect<
      ECS.DescribeServiceRevisionsResponse,
      ECS.DescribeServiceRevisionsError
    >
  >
> {}
export const DescribeServiceRevisions =
  Binding.Service<DescribeServiceRevisions>("AWS.ECS.DescribeServiceRevisions");
