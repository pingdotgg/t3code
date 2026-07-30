import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { TaggableResource } from "./binding-common.ts";

export interface ListTagsForResourceRequest extends Omit<
  cloudwatch.ListTagsForResourceInput,
  "ResourceARN"
> {}

/**
 * Runtime binding for `cloudwatch:ListTagsForResource` — read the tags on
 * a bound CloudWatch resource (alarm, dashboard, metric stream, insight
 * rule, or mute rule); the resource ARN is injected automatically.
 *
 * Provide `CloudWatch.ListTagsForResourceHttp` on the hosting Lambda
 * Function to satisfy the requirement.
 * @binding
 * @section Reading Tags
 * @example Read the Tags on an Alarm
 * ```typescript
 * // init — grants cloudwatch:ListTagsForResource on the alarm's ARN
 * const listTagsForResource = yield* AWS.CloudWatch.ListTagsForResource(alarm);
 *
 * // runtime
 * const result = yield* listTagsForResource();
 * const tags = result.Tags ?? [];
 * ```
 */
export interface ListTagsForResource extends Binding.Service<
  ListTagsForResource,
  "AWS.CloudWatch.ListTagsForResource",
  (
    resource: TaggableResource,
  ) => Effect.Effect<
    (
      request?: ListTagsForResourceRequest,
    ) => Effect.Effect<
      cloudwatch.ListTagsForResourceOutput,
      cloudwatch.ListTagsForResourceError
    >
  >
> {}

export const ListTagsForResource = Binding.Service<ListTagsForResource>(
  "AWS.CloudWatch.ListTagsForResource",
);
