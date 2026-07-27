import type * as opensearch from "@distilled.cloud/aws/opensearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `StartServiceSoftwareUpdate` operation (IAM action
 * `es:StartServiceSoftwareUpdate`).
 *
 * Schedules a service software update for a domain — immediately, at a timestamp, or in the domain's off-peak window — e.g. rolling out a pending security patch fleet-wide. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.StartServiceSoftwareUpdateHttp)`.
 * @binding
 * @section Service Software Updates
 * @example Start a Service Software Update
 * ```typescript
 * const startServiceSoftwareUpdate = yield* OpenSearch.StartServiceSoftwareUpdate();
 *
 * const result = yield* startServiceSoftwareUpdate({ DomainName: name });
 * // result.ServiceSoftwareOptions?.UpdateStatus → "PENDING_UPDATE"
 * ```
 */
export interface StartServiceSoftwareUpdate extends Binding.Service<
  StartServiceSoftwareUpdate,
  "AWS.OpenSearch.StartServiceSoftwareUpdate",
  () => Effect.Effect<
    (
      request: opensearch.StartServiceSoftwareUpdateRequest,
    ) => Effect.Effect<
      opensearch.StartServiceSoftwareUpdateResponse,
      opensearch.StartServiceSoftwareUpdateError
    >
  >
> {}
export const StartServiceSoftwareUpdate =
  Binding.Service<StartServiceSoftwareUpdate>(
    "AWS.OpenSearch.StartServiceSoftwareUpdate",
  );
