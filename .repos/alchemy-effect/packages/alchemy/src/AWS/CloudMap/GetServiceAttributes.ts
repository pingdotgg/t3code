import type * as SD from "@distilled.cloud/aws/servicediscovery";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

/**
 * Runtime binding for `servicediscovery:GetServiceAttributes` — reads the
 * custom key/value attributes stored on the bound {@link Service} (declared
 * via the Service resource's `attributes` prop or written out-of-band).
 * Use it to distribute small pieces of service-level configuration to
 * consumers without an extra config store. Provide the implementation with
 * `Effect.provide(AWS.CloudMap.GetServiceAttributesHttp)`.
 * @binding
 * @section Service Attributes
 * @example Read the Service's Attributes
 * ```typescript
 * const getServiceAttributes =
 *   yield* AWS.CloudMap.GetServiceAttributes(service);
 *
 * const { ServiceAttributes } = yield* getServiceAttributes();
 * console.log(ServiceAttributes?.Attributes?.tier);
 * ```
 */
export interface GetServiceAttributes extends Binding.Service<
  GetServiceAttributes,
  "AWS.CloudMap.GetServiceAttributes",
  <S extends Service>(
    service: S,
  ) => Effect.Effect<
    () => Effect.Effect<
      SD.GetServiceAttributesResponse,
      SD.GetServiceAttributesError
    >
  >
> {}
export const GetServiceAttributes = Binding.Service<GetServiceAttributes>(
  "AWS.CloudMap.GetServiceAttributes",
);
