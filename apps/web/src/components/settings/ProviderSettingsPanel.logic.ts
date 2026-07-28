import {
  AuthOrchestrationOperateScope,
  type AuthSessionState,
  type EnvironmentId,
} from "@t3tools/contracts";

export interface ProviderEnvironmentOptionLike {
  readonly environmentId: EnvironmentId;
  readonly label: string;
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

/**
 * Resolve whether the session may reconfigure providers on an environment.
 *
 * Only the primary environment exposes its own granted scopes to the client
 * today, so remote sessions are optimistic: the connection brokers request
 * `orchestration:operate`, and the environment RPC layer stays authoritative if
 * a narrower credential was minted.
 *
 * Cached session data wins over an in-flight revalidation. The session atom is
 * SWR-backed, so it reports `isPending` on every background refresh; treating
 * that as unknown would flip a working panel back to loading and discard
 * in-progress edits.
 */
export function resolvePrimaryOperateAccess(input: {
  readonly isPrimary: boolean;
  readonly hasDesktopBridge: boolean;
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
  readonly isPending: boolean;
}): ProviderOperateAccess {
  if (!input.isPrimary || input.hasDesktopBridge) {
    return "granted";
  }
  if (input.session === null) {
    return input.isPending ? "pending" : "denied";
  }
  if (!input.session.authenticated) {
    return "denied";
  }
  return (input.session.scopes ?? []).includes(AuthOrchestrationOperateScope)
    ? "granted"
    : "denied";
}

export function classifyProviderEnvironmentAccess(input: {
  readonly connectionPhase:
    | "available"
    | "offline"
    | "connecting"
    | "reconnecting"
    | "connected"
    | "error";
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
