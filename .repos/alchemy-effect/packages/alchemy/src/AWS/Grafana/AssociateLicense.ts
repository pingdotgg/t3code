import type * as grafana from "@distilled.cloud/aws/grafana";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Runtime binding for the `AssociateLicense` operation (IAM action
 * `grafana:AssociateLicense`), scoped to one {@link Workspace}.
 *
 * Assigns a Grafana Enterprise license to the workspace. Pass a valid
 * Grafana Labs token as `grafanaToken` when upgrading to `ENTERPRISE`.
 * Upgrading incurs additional fees. Provide the implementation with
 * `Effect.provide(AWS.Grafana.AssociateLicenseHttp)`.
 * @binding
 * @section Managing Licenses
 * @example Upgrade to Grafana Enterprise
 * ```typescript
 * const associateLicense = yield* Grafana.AssociateLicense(workspace);
 *
 * const { workspace: ws } = yield* associateLicense({
 *   licenseType: "ENTERPRISE",
 *   grafanaToken: token,
 * });
 * // ws.licenseType → "ENTERPRISE"
 * ```
 */
export interface AssociateLicense extends Binding.Service<
  AssociateLicense,
  "AWS.Grafana.AssociateLicense",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: Omit<grafana.AssociateLicenseRequest, "workspaceId">,
    ) => Effect.Effect<
      grafana.AssociateLicenseResponse,
      grafana.AssociateLicenseError
    >
  >
> {}
export const AssociateLicense = Binding.Service<AssociateLicense>(
  "AWS.Grafana.AssociateLicense",
);
