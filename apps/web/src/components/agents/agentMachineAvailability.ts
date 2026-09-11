import { resolveGatewayProfileModelSelection } from "@t3tools/client-runtime/gateway";
import type { McpGatewayProfile } from "@t3tools/contracts";
import type { EnvironmentPresentation } from "../../state/environments";

export function agentMachineUnavailableReason(
  profile: McpGatewayProfile,
  environment: Pick<EnvironmentPresentation, "environmentId" | "connection" | "serverConfig">,
): string | undefined {
  if (
    profile.environmentIds?.length &&
    !profile.environmentIds.includes(environment.environmentId)
  ) {
    return "Not selected in this agent’s settings";
  }
  if (environment.connection.phase !== "connected") {
    return "Not connected — check Settings → Connections";
  }
  if (!environment.serverConfig) return "Loading provider status";
  const providers = environment.serverConfig.providers;
  if (resolveGatewayProfileModelSelection(profile, providers)) return undefined;
  const hasLabels = profile.providerLabel !== undefined && profile.modelLabel !== undefined;
  const matching = providers.filter((provider) =>
    hasLabels
      ? (provider.displayName?.trim() || provider.driver) === profile.providerLabel
      : provider.instanceId === profile.modelSelection?.instanceId,
  );
  const label = profile.providerLabel ?? "Agent provider";
  if (!matching.length) return `${label} is not configured on this machine`;
  const enabled = matching.filter((provider) => provider.enabled);
  if (!enabled.length) return `${label} is disabled`;
  const ready = enabled.filter(
    (provider) => provider.status === "ready" && provider.availability !== "unavailable",
  );
  if (!ready.length) {
    const detail = enabled[0]?.unavailableReason ?? enabled[0]?.message;
    return `${label} is not ready${detail ? `: ${detail}` : " — check Settings → Providers"}`;
  }
  return `Model ${profile.modelLabel ?? profile.modelSelection?.model ?? "selection"} is missing or ambiguous — reselect it in the agent’s settings`;
}
