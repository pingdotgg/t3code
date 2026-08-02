import type * as notifications from "@distilled.cloud/aws/notifications";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { NotificationConfiguration } from "./NotificationConfiguration.ts";

/**
 * Request for {@link ListChannels} — the bound configuration's ARN is
 * injected automatically.
 */
export interface ListChannelsRequest extends Omit<
  notifications.ListChannelsRequest,
  "notificationConfigurationArn"
> {}

/**
 * Runtime binding for `notifications:ListChannels`.
 *
 * List the delivery channel ARNs associated with a notification
 * configuration. Provide the implementation with
 * `Effect.provide(AWS.Notifications.ListChannelsHttp)`.
 * @binding
 * @section Reading Configuration Channels
 * @example List a Configuration's Channels
 * ```typescript
 * // init — bind the operation to the configuration
 * const listChannels = yield* AWS.Notifications.ListChannels(config);
 *
 * // runtime
 * const result = yield* listChannels();
 * const channelArns = result.channels;
 * ```
 */
export interface ListChannels extends Binding.Service<
  ListChannels,
  "AWS.Notifications.ListChannels",
  (
    configuration: NotificationConfiguration,
  ) => Effect.Effect<
    (
      request?: ListChannelsRequest,
    ) => Effect.Effect<
      notifications.ListChannelsResponse,
      notifications.ListChannelsError
    >
  >
> {}

export const ListChannels = Binding.Service<ListChannels>(
  "AWS.Notifications.ListChannels",
);
