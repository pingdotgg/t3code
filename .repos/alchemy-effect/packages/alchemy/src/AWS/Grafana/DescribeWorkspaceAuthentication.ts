import type * as grafana from "@distilled.cloud/aws/grafana";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Runtime binding for the `DescribeWorkspaceAuthentication` operation (IAM
 * action `grafana:DescribeWorkspaceAuthentication`), scoped to one
 * {@link Workspace}.
 *
 * Reads the workspace's authentication configuration — the enabled providers
 * (`AWS_SSO`, `SAML`) and, for SAML, the IdP metadata, assertion-attribute
 * mapping, and role values. Provide the implementation with
 * `Effect.provide(AWS.Grafana.DescribeWorkspaceAuthenticationHttp)`.
 * @binding
 * @section Managing Authentication
 * @example Inspect the SAML Configuration Status
 * ```typescript
 * const describeAuth = yield* Grafana.DescribeWorkspaceAuthentication(workspace);
 *
 * const { authentication } = yield* describeAuth();
 * // authentication.providers → ["SAML"]
 * // authentication.saml?.status → "CONFIGURED" | "NOT_CONFIGURED"
 * ```
 */
export interface DescribeWorkspaceAuthentication extends Binding.Service<
  DescribeWorkspaceAuthentication,
  "AWS.Grafana.DescribeWorkspaceAuthentication",
  (
    workspace: Workspace,
  ) => Effect.Effect<
    () => Effect.Effect<
      grafana.DescribeWorkspaceAuthenticationResponse,
      grafana.DescribeWorkspaceAuthenticationError
    >
  >
> {}
export const DescribeWorkspaceAuthentication =
  Binding.Service<DescribeWorkspaceAuthentication>(
    "AWS.Grafana.DescribeWorkspaceAuthentication",
  );
