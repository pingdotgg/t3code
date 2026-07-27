import type * as SD from "@distilled.cloud/aws/servicediscovery";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

/**
 * `DiscoverInstancesRevision` request with `NamespaceName` and
 * `ServiceName` injected from the bound {@link Service}.
 */
export interface DiscoverInstancesRevisionRequest extends Omit<
  SD.DiscoverInstancesRevisionRequest,
  "NamespaceName" | "ServiceName"
> {}

/**
 * Runtime binding for `servicediscovery:DiscoverInstancesRevision` — the
 * Cloud Map data-plane query that returns the monotonically-increasing
 * revision of the bound {@link Service}'s instance set. Poll it as a cheap
 * change detector and re-call `DiscoverInstances` only when the revision
 * moves. Provide the implementation with
 * `Effect.provide(AWS.CloudMap.DiscoverInstancesRevisionHttp)`.
 * @binding
 * @section Discovering Instances
 * @example Refresh a Cached Instance List Only on Change
 * ```typescript
 * const discoverInstancesRevision =
 *   yield* AWS.CloudMap.DiscoverInstancesRevision(service);
 *
 * const { InstancesRevision } = yield* discoverInstancesRevision();
 * if (InstancesRevision !== lastSeenRevision) {
 *   // instance set changed — re-run DiscoverInstances
 * }
 * ```
 */
export interface DiscoverInstancesRevision extends Binding.Service<
  DiscoverInstancesRevision,
  "AWS.CloudMap.DiscoverInstancesRevision",
  <S extends Service>(
    service: S,
  ) => Effect.Effect<
    (
      request?: DiscoverInstancesRevisionRequest,
    ) => Effect.Effect<
      SD.DiscoverInstancesRevisionResponse,
      SD.DiscoverInstancesRevisionError
    >
  >
> {}
export const DiscoverInstancesRevision =
  Binding.Service<DiscoverInstancesRevision>(
    "AWS.CloudMap.DiscoverInstancesRevision",
  );
