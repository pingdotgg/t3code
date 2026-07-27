import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ContactChannel } from "./ContactChannel.ts";

/**
 * Runtime binding for `ssm-contacts:SendActivationCode`.
 *
 * Send (or re-send) the activation code to the bound contact channel's
 * address. The channel owner passes the code to `ActivateContactChannel`
 * to confirm the channel. The channel's ARN is injected as
 * `ContactChannelId`.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.SendActivationCodeHttp)`.
 * @binding
 * @section Activating Contact Channels
 * @example Send the Activation Code
 * ```typescript
 * const sendActivationCode = yield* AWS.SSMContacts.SendActivationCode(email);
 *
 * // runtime — e.g. behind a "resend code" button
 * yield* sendActivationCode();
 * ```
 */
export interface SendActivationCode extends Binding.Service<
  SendActivationCode,
  "AWS.SSMContacts.SendActivationCode",
  (
    channel: ContactChannel,
  ) => Effect.Effect<
    () => Effect.Effect<
      ssm.SendActivationCodeResult,
      ssm.SendActivationCodeError
    >
  >
> {}
export const SendActivationCode = Binding.Service<SendActivationCode>(
  "AWS.SSMContacts.SendActivationCode",
);
