import type { RuntimeMode } from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";

type CodexRequirements = NonNullable<CodexSchema.V2ConfigRequirementsReadResponse["requirements"]>;

// Mirrors codexRuntimeModeTurnDefaults in CodexAdapterV2, which can't be
// imported here because the adapter already imports this provider.
const CODEX_RUNTIME_MODE_POLICIES: ReadonlyArray<{
  readonly runtimeMode: RuntimeMode;
  readonly sandboxMode: CodexSchema.V2ConfigRequirementsReadResponse__SandboxMode;
  readonly approvalPolicy: "untrusted" | "on-request" | "never";
}> = [
  { runtimeMode: "approval-required", sandboxMode: "read-only", approvalPolicy: "untrusted" },
  {
    runtimeMode: "auto-accept-edits",
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
  },
  { runtimeMode: "auto", sandboxMode: "workspace-write", approvalPolicy: "on-request" },
  { runtimeMode: "full-access", sandboxMode: "danger-full-access", approvalPolicy: "never" },
];

/**
 * The runtime modes Codex accepts under its managed requirements
 * (requirements.toml or MDM). Undefined when nothing restricts them, so every
 * mode stays available.
 */
export function codexRuntimeModesAllowedByRequirements(
  requirements: CodexRequirements | null | undefined,
): ReadonlyArray<RuntimeMode> | undefined {
  const allowedSandboxModes = requirements?.allowedSandboxModes ?? undefined;
  const allowedApprovalPolicies = requirements?.allowedApprovalPolicies ?? undefined;
  if (allowedSandboxModes === undefined && allowedApprovalPolicies === undefined) {
    return undefined;
  }
  return CODEX_RUNTIME_MODE_POLICIES.filter(
    ({ sandboxMode, approvalPolicy }) =>
      (allowedSandboxModes === undefined || allowedSandboxModes.includes(sandboxMode)) &&
      (allowedApprovalPolicies === undefined || allowedApprovalPolicies.includes(approvalPolicy)),
  ).map(({ runtimeMode }) => runtimeMode);
}
