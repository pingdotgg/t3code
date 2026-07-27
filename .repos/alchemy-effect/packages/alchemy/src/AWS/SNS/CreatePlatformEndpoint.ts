import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PlatformApplication } from "./PlatformApplication.ts";

export interface CreatePlatformEndpointRequest extends Omit<
  sns.CreatePlatformEndpointInput,
  "PlatformApplicationArn"
> {}

/**
 * Runtime binding for `sns:CreatePlatformEndpoint`.
 *
 * Bind this operation to a {@link PlatformApplication} to register device
 * push tokens at runtime. The `PlatformApplicationArn` is injected
 * automatically; the call is idempotent per token.
 * Provide the `CreatePlatformEndpointHttp` layer on the Function to implement the binding.
 * @binding
 * @section Mobile Push
 * @example Register a Device Token
 * ```typescript
 * const createEndpoint = yield* SNS.CreatePlatformEndpoint(app);
 * const endpoint = yield* createEndpoint({ Token: deviceToken });
 * ```
 */
export interface CreatePlatformEndpoint extends Binding.Service<
  CreatePlatformEndpoint,
  "AWS.SNS.CreatePlatformEndpoint",
  (
    application: PlatformApplication,
  ) => Effect.Effect<
    (
      request: CreatePlatformEndpointRequest,
    ) => Effect.Effect<
      sns.CreateEndpointResponse,
      sns.CreatePlatformEndpointError
    >
  >
> {}

export const CreatePlatformEndpoint = Binding.Service<CreatePlatformEndpoint>(
  "AWS.SNS.CreatePlatformEndpoint",
);
