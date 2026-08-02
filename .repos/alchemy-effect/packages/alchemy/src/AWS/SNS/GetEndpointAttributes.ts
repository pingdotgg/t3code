import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PlatformApplication } from "./PlatformApplication.ts";

export interface GetEndpointAttributesRequest
  extends sns.GetEndpointAttributesInput {}

/**
 * Runtime binding for `sns:GetEndpointAttributes`.
 *
 * Bind this operation to a {@link PlatformApplication} to read the
 * attributes (`Token`, `Enabled`, `CustomUserData`) of one of its device
 * endpoints.
 * Provide the `GetEndpointAttributesHttp` layer on the Function to implement the binding.
 * @binding
 * @section Mobile Push
 * @example Read Endpoint Attributes
 * ```typescript
 * const getEndpointAttributes = yield* SNS.GetEndpointAttributes(app);
 * const { Attributes } = yield* getEndpointAttributes({
 *   EndpointArn: endpointArn,
 * });
 * ```
 */
export interface GetEndpointAttributes extends Binding.Service<
  GetEndpointAttributes,
  "AWS.SNS.GetEndpointAttributes",
  (
    application: PlatformApplication,
  ) => Effect.Effect<
    (
      request: GetEndpointAttributesRequest,
    ) => Effect.Effect<
      sns.GetEndpointAttributesResponse,
      sns.GetEndpointAttributesError
    >
  >
> {}

export const GetEndpointAttributes = Binding.Service<GetEndpointAttributes>(
  "AWS.SNS.GetEndpointAttributes",
);
