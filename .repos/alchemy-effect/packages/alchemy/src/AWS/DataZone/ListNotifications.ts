import type * as datazone from "@distilled.cloud/aws/datazone";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Domain } from "./Domain.ts";

export interface ListNotificationsRequest extends Omit<
  datazone.ListNotificationsInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:ListNotifications`.
 *
 * Lists task or event notifications for the calling user in the bound domain. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.ListNotificationsHttp)`.
 * @binding
 * @section Portal, Profiles & Notifications
 * @example Read Pending Tasks
 * ```typescript
 * // init — bind the operation to the domain
 * const listNotifications = yield* AWS.DataZone.ListNotifications(domain);
 *
 * // runtime
 * const tasks = yield* listNotifications({ type: "TASK", taskStatus: "ACTIVE" });
 * ```
 */
export interface ListNotifications extends Binding.Service<
  ListNotifications,
  "AWS.DataZone.ListNotifications",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: ListNotificationsRequest,
    ) => Effect.Effect<
      datazone.ListNotificationsOutput,
      datazone.ListNotificationsError
    >
  >
> {}
export const ListNotifications = Binding.Service<ListNotifications>(
  "AWS.DataZone.ListNotifications",
);
