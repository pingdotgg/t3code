import type * as ivs from "@distilled.cloud/aws/ivs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Channel } from "./Channel.ts";

export interface StartViewerSessionRevocationRequest extends Omit<
  ivs.StartViewerSessionRevocationRequest,
  "channelArn"
> {}

/**
 * Runtime binding for `ivs:StartViewerSessionRevocation`.
 *
 * Starts revoking the viewer session for a given viewer ID on the bound
 * {@link Channel} — used with private channels to eject a viewer whose
 * playback authorization token carries that `viewerId`. Optionally revoke
 * every session at or below a token version. The channel ARN is injected
 * from the binding. Provide the implementation with
 * `Effect.provide(AWS.IVS.StartViewerSessionRevocationHttp)`.
 * @binding
 * @section Revoking Viewer Sessions
 * @example Eject a Banned Viewer
 * ```typescript
 * // init — bind the operation to the channel
 * const revokeViewerSession = yield* AWS.IVS.StartViewerSessionRevocation(channel);
 *
 * // runtime
 * yield* revokeViewerSession({ viewerId: "user-123" });
 * ```
 */
export interface StartViewerSessionRevocation extends Binding.Service<
  StartViewerSessionRevocation,
  "AWS.IVS.StartViewerSessionRevocation",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: StartViewerSessionRevocationRequest,
    ) => Effect.Effect<
      ivs.StartViewerSessionRevocationResponse,
      ivs.StartViewerSessionRevocationError
    >
  >
> {}
export const StartViewerSessionRevocation =
  Binding.Service<StartViewerSessionRevocation>(
    "AWS.IVS.StartViewerSessionRevocation",
  );
