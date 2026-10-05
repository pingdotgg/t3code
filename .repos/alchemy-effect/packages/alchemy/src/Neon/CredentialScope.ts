import * as Effect from "effect/Effect";
import * as Output from "../Output.ts";
import type { ProviderMode } from "../ProviderMode.ts";
import { isResource, type ResourceLike } from "../Resource.ts";
import type { AIGatewayProps } from "./AIGateway.ts";

type CredentialScope = Pick<AIGatewayProps, "branch" | "project">;

export const scopeIdentity = (scope: CredentialScope) => {
  const source = scope.branch ?? scope.project;
  if (isResource(source)) return `${source.Type}:${source.FQN}`;
  if (Effect.isEffect(source) || Output.isOutput(source)) return undefined;
  if (
    typeof scope.branch?.projectId === "string" &&
    typeof scope.branch.branchId === "string"
  ) {
    return `branch:${scope.branch.projectId}:${scope.branch.branchId}`;
  }
  if (typeof scope.project?.projectId === "string")
    return `project:${scope.project.projectId}`;
  return undefined;
};

/** Unknown scope identity falls back to a managed credential. */
export const usesInjectedCredentials = (
  host: Pick<ResourceLike, "Type" | "Props" | "Mode"> | undefined,
  target: CredentialScope,
  defaultMode: ProviderMode,
) => {
  if (host?.Type !== "Neon.Function" || (host.Mode ?? defaultMode) !== "live")
    return false;
  const current: CredentialScope | undefined = host.Props;
  if (!current || Effect.isEffect(current) || Output.isOutput(current))
    return false;
  return (
    (current.branch !== undefined && current.branch === target.branch) ||
    (current.project !== undefined && current.project === target.project) ||
    (scopeIdentity(current) !== undefined &&
      scopeIdentity(current) === scopeIdentity(target))
  );
};
