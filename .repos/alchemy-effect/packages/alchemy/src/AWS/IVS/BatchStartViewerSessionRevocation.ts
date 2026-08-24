import type * as ivs from "@distilled.cloud/aws/ivs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `ivs:BatchStartViewerSessionRevocation`.
 *
 * Starts revoking viewer sessions for up to 20 channel-ARN/viewer-ID
 * pairs in one call — the multi-channel form of
 * `StartViewerSessionRevocation` (e.g. kicking a banned viewer off every
 * channel they are watching). Per-pair failures are reported in the
 * response's `errors` array rather than failing the whole call. The
 * operation spans many channels, so it is account-scoped. Provide the
 * implementation with
 * `Effect.provide(AWS.IVS.BatchStartViewerSessionRevocationHttp)`.
 * @binding
 * @section Revoking Viewer Sessions
 * @example Revoke a Viewer Across Channels
 * ```typescript
 * // init — bind the account-level operation
 * const revokeViewerSessions =
 *   yield* AWS.IVS.BatchStartViewerSessionRevocation();
 *
 * // runtime
 * const { errors } = yield* revokeViewerSessions({
 *   viewerSessions: [
 *     { channelArn: channelA, viewerId: "banned-viewer" },
 *     { channelArn: channelB, viewerId: "banned-viewer" },
 *   ],
 * });
 * ```
 */
export interface BatchStartViewerSessionRevocation extends Binding.Service<
  BatchStartViewerSessionRevocation,
  "AWS.IVS.BatchStartViewerSessionRevocation",
  () => Effect.Effect<
    (
      request: ivs.BatchStartViewerSessionRevocationRequest,
    ) => Effect.Effect<
      ivs.BatchStartViewerSessionRevocationResponse,
      ivs.BatchStartViewerSessionRevocationError
    >
  >
> {}
export const BatchStartViewerSessionRevocation =
  Binding.Service<BatchStartViewerSessionRevocation>(
    "AWS.IVS.BatchStartViewerSessionRevocation",
  );
