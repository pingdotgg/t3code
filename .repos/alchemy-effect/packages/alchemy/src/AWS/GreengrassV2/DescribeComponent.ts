import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ComponentVersion } from "./ComponentVersion.ts";

/**
 * Runtime binding for `greengrass:DescribeComponent`.
 *
 * Reads the bound {@link ComponentVersion}'s cloud metadata — publisher,
 * description, lifecycle `status` (`DEPLOYABLE`, `FAILED`, `DEPRECATED`),
 * platforms, and tags — so a function can audit component health before
 * rolling out a deployment. The component version ARN is injected from the
 * binding. Provide the implementation with
 * `Effect.provide(AWS.GreengrassV2.DescribeComponentHttp)`.
 * @binding
 * @section Reading Components
 * @example Check A Component's State
 * ```typescript
 * // init — bind the operation to the component version
 * const describeComponent = yield* AWS.GreengrassV2.DescribeComponent(component);
 *
 * // runtime
 * const metadata = yield* describeComponent();
 * if (metadata.status?.componentState === "DEPRECATED") {
 *   yield* Effect.logWarning(`${metadata.componentName} is deprecated`);
 * }
 * ```
 */
export interface DescribeComponent extends Binding.Service<
  DescribeComponent,
  "AWS.GreengrassV2.DescribeComponent",
  (
    component: ComponentVersion,
  ) => Effect.Effect<
    (
      request?: Omit<greengrassv2.DescribeComponentRequest, "arn">,
    ) => Effect.Effect<
      greengrassv2.DescribeComponentResponse,
      greengrassv2.DescribeComponentError
    >
  >
> {}
export const DescribeComponent = Binding.Service<DescribeComponent>(
  "AWS.GreengrassV2.DescribeComponent",
);
