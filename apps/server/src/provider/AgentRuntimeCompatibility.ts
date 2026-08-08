import type { ProviderAdapterCapabilities } from "./Services/ProviderAdapter.ts";

export type AgentInstructionRequirement = "prompt" | "system-required";
export type AgentNativeToolRequirement = "none" | "sandbox" | "exact";

export interface AgentRuntimeRequirements {
  readonly delegation: boolean;
  readonly instructionPriority: AgentInstructionRequirement;
  readonly nativeToolPolicy: AgentNativeToolRequirement;
  readonly tokenBudget: boolean;
  readonly monetaryBudget: boolean;
}

export type AgentRuntimeCompatibilityIssue =
  | "agent-runtime-undeclared"
  | "mcp-server-injection-unsupported"
  | "system-instructions-unsupported"
  | "sandbox-policy-unsupported"
  | "exact-tool-policy-unsupported"
  | "token-accounting-unsupported"
  | "monetary-accounting-unsupported";

export interface AgentRuntimeCompatibility {
  readonly compatible: boolean;
  readonly issues: ReadonlyArray<AgentRuntimeCompatibilityIssue>;
}

/**
 * Compares requested Agent guarantees with what an adapter truthfully exposes.
 * An absent declaration is incompatible instead of inheriting optimistic
 * defaults, which keeps new and third-party providers safe by construction.
 */
export function resolveAgentRuntimeCompatibility(
  capabilities: ProviderAdapterCapabilities,
  requirements: AgentRuntimeRequirements,
): AgentRuntimeCompatibility {
  const runtime = capabilities.agentRuntime;
  if (!runtime) {
    return { compatible: false, issues: ["agent-runtime-undeclared"] };
  }

  const issues: AgentRuntimeCompatibilityIssue[] = [];
  if (requirements.delegation && !runtime.mcpServerInjection) {
    issues.push("mcp-server-injection-unsupported");
  }
  if (
    requirements.instructionPriority === "system-required" &&
    runtime.instructionDelivery !== "developer" &&
    runtime.instructionDelivery !== "system"
  ) {
    issues.push("system-instructions-unsupported");
  }
  if (
    requirements.nativeToolPolicy === "sandbox" &&
    runtime.nativeToolPolicy !== "sandbox-only" &&
    runtime.nativeToolPolicy !== "exact"
  ) {
    issues.push("sandbox-policy-unsupported");
  }
  if (requirements.nativeToolPolicy === "exact" && runtime.nativeToolPolicy !== "exact") {
    issues.push("exact-tool-policy-unsupported");
  }
  if (requirements.tokenBudget && !runtime.tokenUsage) {
    issues.push("token-accounting-unsupported");
  }
  if (requirements.monetaryBudget && !runtime.monetaryCost) {
    issues.push("monetary-accounting-unsupported");
  }

  return { compatible: issues.length === 0, issues };
}
