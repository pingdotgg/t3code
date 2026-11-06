import {
  type AuthMcpApprovalDetails,
  type AuthMcpClientAccess,
  isRuntimeModeAbove,
} from "@t3tools/contracts";

export function resolveMcpAccess(
  access: AuthMcpClientAccess,
  ceiling: AuthMcpApprovalDetails["runtimeModeCeiling"],
) {
  return access !== "read-only" &&
    ceiling !== undefined &&
    isRuntimeModeAbove(access, ceiling.maxRuntimeMode)
    ? ceiling.maxRuntimeMode
    : access;
}
