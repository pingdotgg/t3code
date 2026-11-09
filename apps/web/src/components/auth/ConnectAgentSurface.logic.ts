import {
  type AuthMcpApprovalDecision,
  type AuthMcpApprovalDetails,
  type AuthMcpClientAccess,
  isRuntimeModeAbove,
  parseMcpApprovalCode,
} from "@t3tools/contracts";

/** The picker's access: the user's choice, else Read only, lowered to a managed ceiling. */
export function resolveMcpAccess(
  requested: AuthMcpClientAccess | null,
  ceiling: AuthMcpApprovalDetails["runtimeModeCeiling"],
): AuthMcpClientAccess {
  const access = requested ?? "read-only";
  return access !== "read-only" &&
    ceiling !== undefined &&
    isRuntimeModeAbove(access, ceiling.maxRuntimeMode)
    ? ceiling.maxRuntimeMode
    : access;
}

/**
 * What Approve sends. A typed code is always checked as a code, even when the browser's
 * session could approve, and a level-bound code sends its own level. Null: nothing to send.
 */
export function resolveApprovalDecision(input: {
  readonly code: string;
  readonly access: AuthMcpClientAccess;
  readonly details: AuthMcpApprovalDetails;
}): Exclude<AuthMcpApprovalDecision, { readonly _tag: "deny" }> | null {
  const code = input.code.trim();
  if (code.length > 0) {
    return {
      _tag: "pairing-code",
      access: parseMcpApprovalCode(code)?.access ?? input.access,
      code,
    };
  }
  const { csrfToken, oneClickAccess } = input.details;
  return csrfToken !== undefined && (oneClickAccess ?? []).includes(input.access)
    ? { _tag: "browser-session", access: input.access, csrfToken }
    : null;
}
