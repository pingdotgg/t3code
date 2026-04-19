import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProvider,
} from "@workbench/contracts";

export const COWORK_SHELL = {
  hideGitSurfaces: true,
  hideTerminalSurfaces: true,
  hideDiffSurfaces: true,
} as const;

export const TASK_LABEL_SINGULAR = "task";
export const TASK_LABEL_PLURAL = "tasks";

export function formatProviderDisplayLabel(provider: ProviderKind | string): string {
  const knownLabel = PROVIDER_DISPLAY_NAMES[provider as ProviderKind];
  if (knownLabel) {
    return knownLabel;
  }

  return provider
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function describeProviderAvailability(
  provider: Pick<ServerProvider, "enabled" | "installed" | "status">,
): string {
  if (!provider.enabled) {
    return "Disabled";
  }
  if (!provider.installed) {
    return "Not installed";
  }
  if (provider.status === "error") {
    return "Unavailable";
  }
  if (provider.status === "warning") {
    return "Limited";
  }
  if (provider.status === "disabled") {
    return "Disabled";
  }
  return "Ready";
}
