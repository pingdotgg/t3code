import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  AuthProvidersManageScope,
  type AuthSessionState,
  type EnvironmentId,
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
): ReadonlyArray<T> {
  return environments.toSorted((left, right) => {
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
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
}): ProviderOperateAccess {
  if (input.hasError) return "denied";
  if (input.session === null) return input.isPending ? "pending" : "denied";
  return input.session.authenticated && input.session.scopes?.includes(AuthProvidersManageScope)
    ? "granted"
    : "denied";
}

export function resolvePrimaryOperateAccess(input: {
  readonly isPrimary: boolean;
  readonly hasDesktopBridge: boolean;
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
}): ProviderOperateAccess {
  return resolveSessionOperateAccess(input);
}

export function resolveRemoteOperateAccess(input: {
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
}): ProviderOperateAccess {
  return resolveSessionOperateAccess(input);
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
