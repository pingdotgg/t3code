import type * as grafana from "@distilled.cloud/aws/grafana";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListVersions` operation (IAM action
 * `grafana:ListVersions`).
 *
 * Lists the Grafana versions available when creating a workspace, or — with
 * a `workspaceId` — the versions an existing workspace can be upgraded to.
 * Provide the implementation with
 * `Effect.provide(AWS.Grafana.ListVersionsHttp)`.
 * @binding
 * @section Managing Configuration
 * @example List the Available Grafana Versions
 * ```typescript
 * const listVersions = yield* Grafana.ListVersions();
 *
 * const { grafanaVersions } = yield* listVersions();
 * // grafanaVersions → ["10.4", "9.4", ...]
 * ```
 */
export interface ListVersions extends Binding.Service<
  ListVersions,
  "AWS.Grafana.ListVersions",
  () => Effect.Effect<
    (
      request?: grafana.ListVersionsRequest,
    ) => Effect.Effect<grafana.ListVersionsResponse, grafana.ListVersionsError>
  >
> {}
export const ListVersions = Binding.Service<ListVersions>(
  "AWS.Grafana.ListVersions",
);
