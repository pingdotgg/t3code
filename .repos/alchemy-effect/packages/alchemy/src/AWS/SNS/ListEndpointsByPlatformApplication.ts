import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PlatformApplication } from "./PlatformApplication.ts";

export interface ListEndpointsByPlatformApplicationRequest extends Omit<
  sns.ListEndpointsByPlatformApplicationInput,
  "PlatformApplicationArn"
> {}

/**
 * Runtime binding for `sns:ListEndpointsByPlatformApplication`.
 *
 * Bind this operation to a {@link PlatformApplication} to page through its
 * registered device endpoints.
 * Provide the `ListEndpointsByPlatformApplicationHttp` layer on the Function to implement the binding.
 * @binding
 * @section Mobile Push
 * @example List Device Endpoints
 * ```typescript
 * const listEndpoints = yield* SNS.ListEndpointsByPlatformApplication(app);
 * const { Endpoints } = yield* listEndpoints();
 * ```
 */
export interface ListEndpointsByPlatformApplication extends Binding.Service<
  ListEndpointsByPlatformApplication,
  "AWS.SNS.ListEndpointsByPlatformApplication",
  (
    application: PlatformApplication,
  ) => Effect.Effect<
    (
      request?: ListEndpointsByPlatformApplicationRequest,
    ) => Effect.Effect<
      sns.ListEndpointsByPlatformApplicationResponse,
      sns.ListEndpointsByPlatformApplicationError
    >
  >
> {}

export const ListEndpointsByPlatformApplication =
  Binding.Service<ListEndpointsByPlatformApplication>(
    "AWS.SNS.ListEndpointsByPlatformApplication",
  );
