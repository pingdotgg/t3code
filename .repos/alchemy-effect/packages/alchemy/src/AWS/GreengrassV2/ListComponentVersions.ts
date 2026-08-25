import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `greengrass:ListComponentVersions`.
 *
 * Enumerates every registered version of a component, newest first. The
 * caller supplies the component's base ARN
 * (`arn:aws:greengrass:…:components:{name}`, without the `:versions:`
 * suffix). Provide the implementation with
 * `Effect.provide(AWS.GreengrassV2.ListComponentVersionsHttp)`.
 * @binding
 * @section Reading Components
 * @example List A Component's Versions
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listComponentVersions = yield* AWS.GreengrassV2.ListComponentVersions();
 *
 * // runtime
 * const { componentVersions } = yield* listComponentVersions({
 *   arn: componentBaseArn,
 * });
 * ```
 */
export interface ListComponentVersions extends Binding.Service<
  ListComponentVersions,
  "AWS.GreengrassV2.ListComponentVersions",
  () => Effect.Effect<
    (
      request: greengrassv2.ListComponentVersionsRequest,
    ) => Effect.Effect<
      greengrassv2.ListComponentVersionsResponse,
      greengrassv2.ListComponentVersionsError
    >
  >
> {}
export const ListComponentVersions = Binding.Service<ListComponentVersions>(
  "AWS.GreengrassV2.ListComponentVersions",
);
