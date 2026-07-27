import * as sns from "@distilled.cloud/aws/sns";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface PublishSmsRequest extends Omit<
  sns.PublishInput,
  "TopicArn" | "TargetArn"
> {}

/**
 * Runtime binding for `sns:Publish`.
 *
 * Runtime binding for direct SMS delivery with `sns:Publish` — send a text
 * message straight to a phone number without a topic. Accounts start in the
 * SMS sandbox, where only verified destination numbers are deliverable.
 * Provide the `PublishSmsHttp` layer on the Function to implement the binding.
 * @binding
 * @section Sending SMS
 * @example Send a Text Message
 * ```typescript
 * const publishSms = yield* SNS.PublishSms();
 * yield* publishSms({
 *   PhoneNumber: "+15555550123",
 *   Message: "Your code is 123456",
 * });
 * ```
 */
export interface PublishSms extends Binding.Service<
  PublishSms,
  "AWS.SNS.PublishSms",
  () => Effect.Effect<
    (
      request: PublishSmsRequest,
    ) => Effect.Effect<sns.PublishResponse, sns.PublishError>
  >
> {}

export const PublishSms = Binding.Service<PublishSms>("AWS.SNS.PublishSms");
