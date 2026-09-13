import type * as ssm from "@distilled.cloud/aws/ssm-contacts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ContactChannel } from "./ContactChannel.ts";

/**
 * Runtime binding for `ssm-contacts:DeactivateContactChannel`.
 *
 * Deactivate the bound contact channel so Incident Manager stops paging
 * through it — e.g. while the owner is on leave. The channel's ARN is
 * injected as `ContactChannelId`.
 * Provide the implementation with
 * `Effect.provide(AWS.SSMContacts.DeactivateContactChannelHttp)`.
 * ### Activating Contact Channels
 * **Example:** Deactivate a Channel
 * ```typescript
 * const deactivateContactChannel = yield* AWS.SSMContacts.DeactivateContactChannel(email);
 *
 * yield* deactivateContactChannel();
 * ```
 *
 * @binding
 */
export interface DeactivateContactChannel extends Binding.Service<
  DeactivateContactChannel,
  "AWS.SSMContacts.DeactivateContactChannel",
  (
    channel: ContactChannel,
  ) => Effect.Effect<
    () => Effect.Effect<
      ssm.DeactivateContactChannelResult,
      ssm.DeactivateContactChannelError
    >
  >
> {}
export const DeactivateContactChannel =
  Binding.Service<DeactivateContactChannel>(
    "AWS.SSMContacts.DeactivateContactChannel",
  );
