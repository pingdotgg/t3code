import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PlatformApplication } from "./PlatformApplication.ts";

export interface DeleteEndpointRequest extends sns.DeleteEndpointInput {}

/**
 * Runtime binding for `sns:DeleteEndpoint`.
 *
 * Bind this operation to a {@link PlatformApplication} to deregister one
 * of its device endpoints (idempotent).
 * Provide the `DeleteEndpointHttp` layer on the Function to implement the binding.
 * @binding
 * @section Mobile Push
 * @example Delete an Endpoint
 * ```typescript
 * const deleteEndpoint = yield* SNS.DeleteEndpoint(app);
 * yield* deleteEndpoint({ EndpointArn: endpointArn });
 * ```
 */
export interface DeleteEndpoint extends Binding.Service<
  DeleteEndpoint,
  "AWS.SNS.DeleteEndpoint",
  (
    application: PlatformApplication,
  ) => Effect.Effect<
    (
      request: DeleteEndpointRequest,
    ) => Effect.Effect<sns.DeleteEndpointResponse, sns.DeleteEndpointError>
  >
> {}

export const DeleteEndpoint = Binding.Service<DeleteEndpoint>(
  "AWS.SNS.DeleteEndpoint",
);
