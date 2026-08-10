import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  AuthAccessWriteScope,
  type AuthSessionState,
  type EnvironmentId,
  type VoiceCredentialStatus,
} from "@t3tools/contracts";

export interface VoiceEnvironmentOptionLike {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function buildVoiceEnvironmentOptions<T extends VoiceEnvironmentOptionLike>(
  environments: ReadonlyArray<T>,
  primaryEnvironmentId: EnvironmentId | null,
): ReadonlyArray<T> {
  return environments.toSorted((left, right) => {
    const leftIsPrimary = left.environmentId === primaryEnvironmentId;
    const rightIsPrimary = right.environmentId === primaryEnvironmentId;
    if (leftIsPrimary !== rightIsPrimary) return leftIsPrimary ? -1 : 1;
    return (
      left.label.localeCompare(right.label) ||
      String(left.environmentId).localeCompare(String(right.environmentId))
    );
  });
}

export function resolveSelectedVoiceEnvironmentId(
  environments: ReadonlyArray<VoiceEnvironmentOptionLike>,
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

export type VoiceCredentialWriteAccess = "granted" | "denied" | "pending" | "unknown";

/**
 * Resolve access from the environment's authenticated session without
 * inventing authority. Missing or failed scope discovery stays unknown and
 * lets the typed credential endpoint make the final decision.
 */
export function resolveVoiceCredentialWriteAccess(input: {
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
  readonly isPending: boolean;
}): VoiceCredentialWriteAccess {
  if (input.session === null) return input.isPending ? "pending" : "unknown";
  if (!input.session.authenticated) return "denied";
  if (input.session.scopes === undefined) return "unknown";
  return input.session.scopes.includes(AuthAccessWriteScope) ? "granted" : "denied";
}

export type VoiceEnvironmentAvailability =
  | { readonly kind: "ready" }
  | { readonly kind: "loading"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "unsupported"; readonly message: string };

export function classifyVoiceEnvironmentAvailability(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly hasServerConfig: boolean;
  readonly supportsRealtimeVoice: boolean;
  readonly hasPreparedConnection: boolean;
}): VoiceEnvironmentAvailability {
  if (input.connectionPhase !== "connected") {
    const message =
      input.connectionPhase === "error"
        ? "T3 could not connect to this environment."
        : input.connectionPhase === "offline"
          ? "This environment is offline."
          : "Waiting for this environment to connect.";
    return { kind: "unavailable", message };
  }
  if (!input.hasServerConfig) {
    return { kind: "loading", message: "Reading this environment's capabilities." };
  }
  if (!input.supportsRealtimeVoice) {
    return {
      kind: "unsupported",
      message: "This environment does not support Realtime voice yet. Update its T3 server.",
    };
  }
  if (!input.hasPreparedConnection) {
    return { kind: "loading", message: "Preparing a secure connection to this environment." };
  }
  return { kind: "ready" };
}

export function describeVoiceCredentialStatus(status: VoiceCredentialStatus): string {
  if (!status.configured) return "No OpenAI API key is configured.";
  return status.source === "stored"
    ? "A write-only OpenAI API key is stored by this environment."
    : "This environment is using OPENAI_API_KEY from its host process.";
}

/** Convert only known error tags into copy; never render an error message or cause. */
export function voiceCredentialErrorMessage(error: unknown): string {
  const tag =
    typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "Unknown";
  switch (tag) {
    case "EnvironmentScopeRequiredError":
    case "EnvironmentOperationForbiddenError":
      return "This session cannot manage the OpenAI API key. Reconnect with access:write permission or configure it on the environment host.";
    case "EnvironmentAuthInvalidError":
      return "Authentication for this environment expired. Reconnect and try again.";
    case "RemoteEnvironmentAuthTimeoutError":
      return "The environment did not respond in time. Try again.";
    case "RemoteEnvironmentAuthFetchError":
      return "T3 could not reach this environment. Check its connection and try again.";
    case "RemoteEnvironmentAuthInvalidJsonError":
    case "RemoteEnvironmentAuthUndeclaredStatusError":
      return "The environment returned an unsupported credential response.";
    case "EnvironmentInternalError":
      return "The environment could not read or update the OpenAI credential.";
    default:
      return "The OpenAI credential request failed. Try again.";
  }
}

export function isVoiceCredentialPermissionDenied(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
  return (
    error._tag === "EnvironmentScopeRequiredError" ||
    error._tag === "EnvironmentOperationForbiddenError"
  );
}
