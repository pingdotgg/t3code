import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { PlatformApplication } from "./PlatformApplication.ts";

export interface PublishToEndpointRequest extends Omit<
  sns.PublishInput,
  "TopicArn" | "PhoneNumber"
> {}

/**
 * Runtime binding for `sns:Publish`.
 *
 * Runtime binding for `sns:Publish` targeting a mobile-push endpoint of a
 * {@link PlatformApplication}: pass the device `TargetArn` returned by
 * `CreatePlatformEndpoint`.
 * Provide the `PublishToEndpointHttp` layer on the Function to implement the binding.
 * @binding
 * @section Mobile Push
 * @example Push to a Device
 * ```typescript
 * const publishToEndpoint = yield* SNS.PublishToEndpoint(app);
 * yield* publishToEndpoint({
 *   TargetArn: endpointArn,
 *   Message: "hello",
 * });
 * ```
 */
export interface PublishToEndpoint extends Binding.Service<
  PublishToEndpoint,
  "AWS.SNS.PublishToEndpoint",
  (
    application: PlatformApplication,
  ) => Effect.Effect<
    (
      request: PublishToEndpointRequest,
    ) => Effect.Effect<sns.PublishResponse, sns.PublishError>
  >
> {}

export const PublishToEndpoint = Binding.Service<PublishToEndpoint>(
  "AWS.SNS.PublishToEndpoint",
);
