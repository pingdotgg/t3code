import type * as mediapackagev2 from "@distilled.cloud/aws/mediapackagev2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { OriginEndpoint } from "./OriginEndpoint.ts";

/**
 * Runtime binding for `mediapackagev2:ResetOriginEndpointState`.
 *
 * Resets the packaging state of the bound {@link OriginEndpoint} — clearing
 * its manifests and cached segments so playback restarts clean after the
 * channel's content was reset or replaced. The endpoint's group, channel,
 * and name are injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.MediaPackageV2.ResetOriginEndpointStateHttp)`.
 * @binding
 * @section Resetting Ingest State
 * @example Reset an Endpoint After Resetting Its Channel
 * ```typescript
 * // init — bind the operation to the endpoint
 * const resetEndpoint =
 *   yield* AWS.MediaPackageV2.ResetOriginEndpointState(endpoint);
 *
 * // runtime
 * const { ResetAt } = yield* resetEndpoint();
 * ```
 */
export interface ResetOriginEndpointState extends Binding.Service<
  ResetOriginEndpointState,
  "AWS.MediaPackageV2.ResetOriginEndpointState",
  (
    endpoint: OriginEndpoint,
  ) => Effect.Effect<
    () => Effect.Effect<
      mediapackagev2.ResetOriginEndpointStateResponse,
      mediapackagev2.ResetOriginEndpointStateError
    >
  >
> {}
export const ResetOriginEndpointState =
  Binding.Service<ResetOriginEndpointState>(
    "AWS.MediaPackageV2.ResetOriginEndpointState",
  );
