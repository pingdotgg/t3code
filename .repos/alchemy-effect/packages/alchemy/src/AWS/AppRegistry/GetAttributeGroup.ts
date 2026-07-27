import type * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AttributeGroup } from "./AttributeGroup.ts";

/**
 * Runtime binding for `servicecatalog:GetAttributeGroup`.
 *
 * Reads the bound attribute group's user-defined JSON metadata (the
 * `attributes` string) along with its description and tags — the primary
 * way for a running function to consume AppRegistry metadata. Provide the
 * implementation with `Effect.provide(AWS.AppRegistry.GetAttributeGroupHttp)`.
 * @binding
 * @section Reading Attribute Group Metadata
 * @example Read Attributes at Runtime
 * ```typescript
 * // init — bind the operation to the attribute group
 * const getAttributeGroup = yield* AWS.AppRegistry.GetAttributeGroup(group);
 *
 * // runtime
 * const details = yield* getAttributeGroup();
 * const attributes = JSON.parse(details.attributes ?? "{}");
 * ```
 */
export interface GetAttributeGroup extends Binding.Service<
  GetAttributeGroup,
  "AWS.AppRegistry.GetAttributeGroup",
  (
    attributeGroup: AttributeGroup,
  ) => Effect.Effect<
    () => Effect.Effect<
      appregistry.GetAttributeGroupResponse,
      appregistry.GetAttributeGroupError
    >
  >
> {}

export const GetAttributeGroup = Binding.Service<GetAttributeGroup>(
  "AWS.AppRegistry.GetAttributeGroup",
);
