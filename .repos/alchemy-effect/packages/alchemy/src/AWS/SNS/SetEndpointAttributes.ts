import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PlatformApplication } from "./PlatformApplication.ts";

export interface SetEndpointAttributesRequest
  extends sns.SetEndpointAttributesInput {}

/**
 * Runtime binding for `sns:SetEndpointAttributes`.
 *
 * Bind this operation to a {@link PlatformApplication} to update a device
 * endpoint — e.g. re-enable it after a delivery failure or rotate its token.
 * Provide the `SetEndpointAttributesHttp` layer on the Function to implement the binding.
 * @binding
 * @section Mobile Push
 * @example Re-enable an Endpoint
 * ```typescript
 * const setEndpointAttributes = yield* SNS.SetEndpointAttributes(app);
 * yield* setEndpointAttributes({
 *   EndpointArn: endpointArn,
 *   Attributes: { Enabled: "true" },
 * });
 * ```
 */
export interface SetEndpointAttributes extends Binding.Service<
  SetEndpointAttributes,
  "AWS.SNS.SetEndpointAttributes",
  (
    application: PlatformApplication,
  ) => Effect.Effect<
    (
      request: SetEndpointAttributesRequest,
    ) => Effect.Effect<
      sns.SetEndpointAttributesResponse,
      sns.SetEndpointAttributesError
    >
  >
> {}

export const SetEndpointAttributes = Binding.Service<SetEndpointAttributes>(
  "AWS.SNS.SetEndpointAttributes",
);
