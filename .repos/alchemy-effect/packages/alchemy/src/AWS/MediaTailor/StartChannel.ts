import type * as mediatailor from "@distilled.cloud/aws/mediatailor";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `mediatailor:StartChannel` — start a channel-assembly
 * channel so it begins producing its linear stream.
 *
 * Channel names are runtime parameters, so the binding is account-level and
 * grants `mediatailor:StartChannel` on `*`. Provide the implementation with
 * `Effect.provide(AWS.MediaTailor.StartChannelHttp)`.
 *
 * @binding
 * @section Channel Assembly
 * @example Start a channel
 * ```typescript
 * const startChannel = yield* AWS.MediaTailor.StartChannel();
 *
 * yield* startChannel({ ChannelName: "my-channel" });
 * ```
 */
export interface StartChannel extends Binding.Service<
  StartChannel,
  "AWS.MediaTailor.StartChannel",
  () => Effect.Effect<
    (
      request: mediatailor.StartChannelRequest,
    ) => Effect.Effect<
      mediatailor.StartChannelResponse,
      mediatailor.StartChannelError
    >
  >
> {}
export const StartChannel = Binding.Service<StartChannel>(
  "AWS.MediaTailor.StartChannel",
);
