import type * as grafana from "@distilled.cloud/aws/grafana";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Runtime binding for the `ListPermissions` operation (IAM action
 * `grafana:ListPermissions`), scoped to one {@link Workspace}.
 *
 * Lists the IAM Identity Center users and groups granted the `ADMIN`,
 * `EDITOR`, or `VIEWER` role in the workspace, optionally filtered by user
 * or group id. Provide the implementation with
 * `Effect.provide(AWS.Grafana.ListPermissionsHttp)`.
 * @binding
 * @section Managing Permissions
 * @example List Workspace Role Assignments
 * ```typescript
 * const listPermissions = yield* Grafana.ListPermissions(workspace);
 *
 * const { permissions } = yield* listPermissions();
 * for (const entry of permissions) {
 *   yield* Effect.logInfo(`${entry.user.id} → ${entry.role}`);
 * }
 * ```
 */
export interface ListPermissions extends Binding.Service<
  ListPermissions,
  "AWS.Grafana.ListPermissions",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request?: Omit<grafana.ListPermissionsRequest, "workspaceId">,
    ) => Effect.Effect<
      grafana.ListPermissionsResponse,
      grafana.ListPermissionsError
    >
  >
> {}
export const ListPermissions = Binding.Service<ListPermissions>(
  "AWS.Grafana.ListPermissions",
);
