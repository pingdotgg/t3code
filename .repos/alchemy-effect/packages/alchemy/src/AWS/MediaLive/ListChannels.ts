import type * as medialive from "@distilled.cloud/aws/medialive";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `medialive:ListChannels`.
 *
 * Enumerates the account's MediaLive channels (one page per call — pass
 * `NextToken` from the previous response to continue) — e.g. a cost
 * sentinel that finds channels left RUNNING outside broadcast hours.
 * Account-level: the deploy-time grant is `medialive:ListChannels` on
 * `*`. Provide the implementation with
 * `Effect.provide(AWS.MediaLive.ListChannelsHttp)`.
 * @binding
 * @section Observing Channels
 * @example Find Channels Left Running
 * ```typescript
 * // init — bind the account-level operation
 * const listChannels = yield* AWS.MediaLive.ListChannels();
 *
 * // runtime
 * const { Channels } = yield* listChannels({ MaxResults: 20 });
 * const running = (Channels ?? []).filter((c) => c.State === "RUNNING");
 * ```
 */
export interface ListChannels extends Binding.Service<
  ListChannels,
  "AWS.MediaLive.ListChannels",
  () => Effect.Effect<
    (
      request?: medialive.ListChannelsRequest,
    ) => Effect.Effect<
      medialive.ListChannelsResponse,
      medialive.ListChannelsError
    >
  >
> {}
export const ListChannels = Binding.Service<ListChannels>(
  "AWS.MediaLive.ListChannels",
);
