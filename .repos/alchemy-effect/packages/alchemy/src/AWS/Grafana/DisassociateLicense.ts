import type * as grafana from "@distilled.cloud/aws/grafana";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Runtime binding for the `DisassociateLicense` operation (IAM action
 * `grafana:DisassociateLicense`), scoped to one {@link Workspace}.
 *
 * Removes the Grafana Enterprise license from the workspace, downgrading it
 * back to the standard edition. Provide the implementation with
 * `Effect.provide(AWS.Grafana.DisassociateLicenseHttp)`.
 * @binding
 * @section Managing Licenses
 * @example Downgrade from Grafana Enterprise
 * ```typescript
 * const disassociateLicense = yield* Grafana.DisassociateLicense(workspace);
 *
 * yield* disassociateLicense({ licenseType: "ENTERPRISE" });
 * ```
 */
export interface DisassociateLicense extends Binding.Service<
  DisassociateLicense,
  "AWS.Grafana.DisassociateLicense",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    (
      request: Omit<grafana.DisassociateLicenseRequest, "workspaceId">,
    ) => Effect.Effect<
      grafana.DisassociateLicenseResponse,
      grafana.DisassociateLicenseError
    >
  >
> {}
export const DisassociateLicense = Binding.Service<DisassociateLicense>(
  "AWS.Grafana.DisassociateLicense",
);
