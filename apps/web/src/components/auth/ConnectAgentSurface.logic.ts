import {
  type AuthMcpApprovalDecision,
  type AuthMcpApprovalDetails,
  type AuthMcpClientAccess,
  isRuntimeModeAbove,
  parseMcpApprovalCode,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";

/**
 * The picker's access, lowered to a managed ceiling: the user's choice, else Auto for a typed
 * code, else Read only, since approving without a code says nothing about what the user wants.
 */
export function resolveMcpAccess(
  requested: AuthMcpClientAccess | null,
  ceiling: AuthMcpApprovalDetails["runtimeModeCeiling"],
  hasCode: boolean,
): AuthMcpClientAccess {
  const access = requested ?? (hasCode ? "auto" : "read-only");
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

/**
 * The address to send the window to after a decision, or null. Only https, or http on this
 * computer, can carry a sign-in to an agent; anything else, such as `javascript:`, is refused.
 */
export function agentRedirectUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))
    ? parsed.toString()
    : null;
}
