import type * as mediatailor from "@distilled.cloud/aws/mediatailor";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `mediatailor:StopChannel` — stop a running
 * channel-assembly channel.
 *
 * Channel names are runtime parameters, so the binding is account-level and
 * grants `mediatailor:StopChannel` on `*`. Provide the implementation with
 * `Effect.provide(AWS.MediaTailor.StopChannelHttp)`.
 *
 * @binding
 * @section Channel Assembly
 * @example Stop a channel
 * ```typescript
 * const stopChannel = yield* AWS.MediaTailor.StopChannel();
 *
 * yield* stopChannel({ ChannelName: "my-channel" });
 * ```
 */
export interface StopChannel extends Binding.Service<
  StopChannel,
  "AWS.MediaTailor.StopChannel",
  () => Effect.Effect<
    (
      request: mediatailor.StopChannelRequest,
    ) => Effect.Effect<
      mediatailor.StopChannelResponse,
      mediatailor.StopChannelError
    >
  >
> {}
export const StopChannel = Binding.Service<StopChannel>(
  "AWS.MediaTailor.StopChannel",
);
