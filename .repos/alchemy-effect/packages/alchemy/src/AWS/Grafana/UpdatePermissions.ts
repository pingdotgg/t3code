import type * as grafana from "@distilled.cloud/aws/grafana";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Runtime binding for the `UpdatePermissions` operation (IAM action
 * `grafana:UpdatePermissions`), scoped to one {@link Workspace}.
 *
 * Grants or revokes the `ADMIN`, `EDITOR`, or `VIEWER` role for IAM Identity
 * Center users and groups in the workspace. Rejected instructions come back
 * in the response's `errors` list rather than failing the call. Provide the
 * implementation with `Effect.provide(AWS.Grafana.UpdatePermissionsHttp)`.
 * @binding
 * @section Managing Permissions
 * @example Grant a User the Editor Role
 * ```typescript
 * const updatePermissions = yield* Grafana.UpdatePermissions(workspace);
 *
 * const { errors } = yield* updatePermissions({
 *   updateInstructionBatch: [
 *     {
 *       action: "ADD",
 *       role: "EDITOR",
 *       users: [{ id: userId, type: "SSO_USER" }],
 *     },
 *   ],
 * });
 * // errors → [] when every instruction applied
 * ```
 */
export interface UpdatePermissions extends Binding.Service<
  UpdatePermissions,
  "AWS.Grafana.UpdatePermissions",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: Omit<grafana.UpdatePermissionsRequest, "workspaceId">,
    ) => Effect.Effect<
      grafana.UpdatePermissionsResponse,
      grafana.UpdatePermissionsError
    >
  >
> {}
export const UpdatePermissions = Binding.Service<UpdatePermissions>(
  "AWS.Grafana.UpdatePermissions",
);
