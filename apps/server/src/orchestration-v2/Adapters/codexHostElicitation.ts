import type { V2TurnStartParams__AskForApproval } from "effect-codex-app-server/schema";

export function withHostElicitation(policy: V2TurnStartParams__AskForApproval, needed: boolean) {
  if (!needed) return policy;
  if (policy === "never")
    return {
      granular: {
        mcp_elicitations: true,
        rules: false,
        sandbox_approval: false,
        request_permissions: false,
        skill_approval: false,
      },
    };
  return typeof policy === "object"
    ? { granular: { ...policy.granular, mcp_elicitations: true } }
    : policy;
}
export function permitsOrdinaryElicitation(policy: unknown, fullAccess: boolean) {
  if (policy === "never" || (policy === undefined && fullAccess)) return false;
  return !(
    typeof policy === "object" &&
    policy !== null &&
    "granular" in policy &&
    typeof policy.granular === "object" &&
    policy.granular !== null &&
    "mcp_elicitations" in policy.granular &&
    policy.granular.mcp_elicitations === false
  );
}
