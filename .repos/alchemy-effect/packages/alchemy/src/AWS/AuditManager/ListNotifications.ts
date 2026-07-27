import type * as auditmanager from "@distilled.cloud/aws/auditmanager";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `auditmanager:ListNotifications`.
 *
 * Lists the notifications for the account — delegation requests,
 * control-set review handoffs, and completed report generation. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.ListNotificationsHttp)`.
 * @binding
 * @section Notifications
 * @example List Audit Manager Notifications
 * ```typescript
 * const listNotifications = yield* AWS.AuditManager.ListNotifications();
 * const result = yield* listNotifications({ maxResults: 20 });
 * ```
 */
export interface ListNotifications extends Binding.Service<
  ListNotifications,
  "AWS.AuditManager.ListNotifications",
  () => Effect.Effect<
    (
      request?: auditmanager.ListNotificationsRequest,
    ) => Effect.Effect<
      auditmanager.ListNotificationsResponse,
      auditmanager.ListNotificationsError
    >
  >
> {}

export const ListNotifications = Binding.Service<ListNotifications>(
  "AWS.AuditManager.ListNotifications",
);
