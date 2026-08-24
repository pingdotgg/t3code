import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ContactChannel } from "./ContactChannel.ts";

/**
 * Runtime binding for `ssm-contacts:ActivateContactChannel`.
 *
 * Activate the bound contact channel with the code its owner received,
 * so Incident Manager can page through it. The channel's ARN is injected
 * as `ContactChannelId`.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.ActivateContactChannelHttp)`.
 * @binding
 * @section Activating Contact Channels
 * @example Activate a Channel with the Received Code
 * ```typescript
 * const activateContactChannel = yield* AWS.SSMContacts.ActivateContactChannel(email);
 *
 * yield* activateContactChannel({ ActivationCode: "466136" });
 * ```
 */
export interface ActivateContactChannel extends Binding.Service<
  ActivateContactChannel,
  "AWS.SSMContacts.ActivateContactChannel",
  (
    channel: ContactChannel,
  ) => Effect.Effect<
    (
      request: Omit<ssm.ActivateContactChannelRequest, "ContactChannelId">,
    ) => Effect.Effect<
      ssm.ActivateContactChannelResult,
      ssm.ActivateContactChannelError
    >
  >
> {}
export const ActivateContactChannel = Binding.Service<ActivateContactChannel>(
  "AWS.SSMContacts.ActivateContactChannel",
);
