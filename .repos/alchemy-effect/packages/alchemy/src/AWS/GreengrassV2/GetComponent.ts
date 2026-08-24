import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ComponentVersion } from "./ComponentVersion.ts";

/**
 * Runtime binding for `greengrass:GetComponent`.
 *
 * Fetches the bound {@link ComponentVersion}'s recipe (JSON or YAML, as raw
 * bytes) so a function can inspect or mirror the component definition. The
 * component version ARN is injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.GreengrassV2.GetComponentHttp)`.
 * @binding
 * @section Reading Components
 * @example Fetch A Component's Recipe
 * ```typescript
 * // init — bind the operation to the component version
 * const getComponent = yield* AWS.GreengrassV2.GetComponent(component);
 *
 * // runtime
 * const { recipe } = yield* getComponent({ recipeOutputFormat: "JSON" });
 * const text = new TextDecoder().decode(recipe);
 * ```
 */
export interface GetComponent extends Binding.Service<
  GetComponent,
  "AWS.GreengrassV2.GetComponent",
  (
    component: ComponentVersion,
  ) => Effect.Effect<
    (
      request?: Omit<greengrassv2.GetComponentRequest, "arn">,
    ) => Effect.Effect<
      greengrassv2.GetComponentResponse,
      greengrassv2.GetComponentError
    >
  >
> {}
export const GetComponent = Binding.Service<GetComponent>(
  "AWS.GreengrassV2.GetComponent",
);
