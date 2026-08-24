import type * as SD from "@distilled.cloud/aws/servicediscovery";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

/**
 * `ListInstances` request with `ServiceId` injected from the bound
 * {@link Service}.
 */
export interface ListInstancesRequest extends Omit<
  SD.ListInstancesRequest,
  "ServiceId"
> {}

/**
 * Runtime binding for `servicediscovery:ListInstances` — lists summary
 * information (id + attributes) for every instance registered with the
 * bound {@link Service}. Unlike `DiscoverInstances` this is the
 * control-plane view: strongly consistent with registration, one page at a
 * time via `NextToken`. Provide the implementation with
 * `Effect.provide(AWS.CloudMap.ListInstancesHttp)`.
 * @binding
 * @section Reading Instances
 * @example List Registered Instances
 * ```typescript
 * const listInstances = yield* AWS.CloudMap.ListInstances(service);
 *
 * const { Instances } = yield* listInstances();
 * for (const instance of Instances ?? []) {
 *   console.log(instance.Id, instance.Attributes);
 * }
 * ```
 */
export interface ListInstances extends Binding.Service<
  ListInstances,
  "AWS.CloudMap.ListInstances",
  <S extends Service>(
    service: S,
  ) => Effect.Effect<
    (
      request?: ListInstancesRequest,
    ) => Effect.Effect<SD.ListInstancesResponse, SD.ListInstancesError>
  >
> {}
export const ListInstances = Binding.Service<ListInstances>(
  "AWS.CloudMap.ListInstances",
);
