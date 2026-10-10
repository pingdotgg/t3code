import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  AuthProvidersManageScope,
  type AuthSessionState,
  type EnvironmentId,
  type ProjectId,
  type ProjectSettingsOverrides,
  type ProviderInstanceId,
  sessionGrantsScope,
  type ServerSettings,
  type SessionGrantInput,
} from "@t3tools/contracts";

export interface ProviderEnvironmentOptionLike {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function isProviderSettingsEnvironmentAvailable(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly hasServerConfig: boolean;
}): boolean {
  return input.connectionPhase === "connected" && input.hasServerConfig;
}

export function buildProviderEnvironmentOptions<T extends ProviderEnvironmentOptionLike>(
  environments: ReadonlyArray<T>,
  primaryEnvironmentId: EnvironmentId | null,
  environmentIds?: readonly EnvironmentId[],
): ReadonlyArray<T> {
  const allowed = environmentIds ? new Set(environmentIds) : null;
  return environments
    .filter((environment) => !allowed || allowed.has(environment.environmentId))
    .toSorted((left, right) => {
      const leftIsPrimary = left.environmentId === primaryEnvironmentId;
      const rightIsPrimary = right.environmentId === primaryEnvironmentId;
      if (leftIsPrimary !== rightIsPrimary) {
        return leftIsPrimary ? -1 : 1;
      }
      return (
        left.label.localeCompare(right.label) ||
        String(left.environmentId).localeCompare(String(right.environmentId))
      );
    });
}

export function resolveSelectedProviderEnvironmentId(
  environments: ReadonlyArray<ProviderEnvironmentOptionLike>,
  selectedEnvironmentId: EnvironmentId | null,
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  if (
    selectedEnvironmentId !== null &&
    environments.some((environment) => environment.environmentId === selectedEnvironmentId)
  ) {
    return selectedEnvironmentId;
  }
  if (
    primaryEnvironmentId !== null &&
    environments.some((environment) => environment.environmentId === primaryEnvironmentId)
  ) {
    return primaryEnvironmentId;
  }
  return environments[0]?.environmentId ?? null;
}

export type ProviderEnvironmentAccess =
  | { readonly kind: "editable" }
  /** `reason` distinguishes waiting on the device from waiting on permissions. */
  | { readonly kind: "loading"; readonly reason: "config" | "permissions" }
  | { readonly kind: "read-only" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error" };

/**
 * Whether the session may change provider configuration on an environment.
 * `pending` means the answer is still unknown, which must not be presented as
 * editable: rendering controls we already know might be rejected only turns a
 * permission problem into a failed write.
 */
export type ProviderOperateAccess = "granted" | "denied" | "pending";

/** Cached grants remain usable during revalidation; unknown or failed lookups grant nothing. */
function resolveSessionOperateAccess(input: {
  readonly session: SessionGrantInput | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
}): ProviderOperateAccess {
  if (input.hasError) return "denied";
  if (input.session === null) return input.isPending ? "pending" : "denied";
  return sessionGrantsScope(input.session, AuthProvidersManageScope) ? "granted" : "denied";
}

export function resolvePrimaryOperateAccess(input: {
  readonly isPrimary: boolean;
  readonly hasDesktopBridge: boolean;
  readonly session: SessionGrantInput | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
}): ProviderOperateAccess {
  return resolveSessionOperateAccess(input);
}

export function resolveRemoteOperateAccess(input: {
  readonly session: SessionGrantInput | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
}): ProviderOperateAccess {
  return resolveSessionOperateAccess(input);
}

/**
 * The patch for one instance's project override, following the envelope
 * replacement rule for `projectSettingsOverrides`: the returned entry
 * replaces the project's whole override set, and `null` removes it.
 * `value: undefined` resets that single instance back to inheriting the
 * environment's enablement, leaving any other overridden keys untouched.
 */
export function buildProviderInstanceEnablementOverridePatch(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  value: boolean | undefined,
): Record<ProjectId, ProjectSettingsOverrides | null> {
  const current = settings.projectSettingsOverrides[projectId];
  const enablement = { ...current?.providerInstanceEnablement };
  if (value === undefined) delete enablement[instanceId];
  else enablement[instanceId] = value;

  const { providerInstanceEnablement: _omit, ...rest } = current ?? {};
  const nextEntry: ProjectSettingsOverrides =
    Object.keys(enablement).length > 0 ? { ...rest, providerInstanceEnablement: enablement } : rest;

  return { [projectId]: Object.keys(nextEntry).length === 0 ? null : nextEntry };
}

export function classifyProviderEnvironmentAccess(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly hasServerConfig: boolean;
  readonly operateAccess: ProviderOperateAccess;
}): ProviderEnvironmentAccess {
  if (input.connectionPhase === "error") {
    return { kind: "error" };
  }
  if (input.connectionPhase !== "connected") {
    return { kind: "unavailable" };
  }
  if (!input.hasServerConfig) {
    return { kind: "loading", reason: "config" };
  }
  if (input.operateAccess === "pending") {
    return { kind: "loading", reason: "permissions" };
  }
  if (input.operateAccess === "denied") {
    return { kind: "read-only" };
  }
  return { kind: "editable" };
}
