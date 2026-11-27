import { providerClients } from "@t3tools/client-runtime/provider-clients";
import type { TeamPrepromptInjectionScope, TeamProviderDeliveryStrategy } from "@t3tools/contracts";
import type { useGT } from "gt-react";

export interface TeamDriverOption {
  readonly value: string;
  readonly label: string;
}

function driverDisplayLabel(driverKind: string, registryLabel: string): string {
  if (driverKind === "claudeAgent") return "Claude Code";
  // oxlint-disable-next-line t3code/no-untranslated-copy -- Proper provider brand name.
  if (driverKind === "antigravity") return "Antigravity (Gemini)";
  // oxlint-disable-next-line t3code/no-untranslated-copy -- Provider driver display label.
  if (driverKind === "acpRegistry") return "ACP / Custom Gateway";
  return registryLabel;
}

/**
 * Unified list of supported provider drivers derived directly from the registered
 * `providerClients` registry so Team Providers and Team Skills/Pre-prompts never drift.
 */
export const TEAM_PROVIDER_DRIVER_OPTIONS: ReadonlyArray<TeamDriverOption> =
  providerClients.definitions.map((client) => ({
    value: client.driverKind,
    label: driverDisplayLabel(client.driverKind, client.label),
  }));

export function formatTeamDriverLabel(driver: string, gt: ReturnType<typeof useGT>): string {
  if (driver === "*") return gt("All providers (*)");
  const match = TEAM_PROVIDER_DRIVER_OPTIONS.find((option) => option.value === driver);
  return match?.label ?? driver;
}

export function getTeamAssetDriverOptions(
  gt: ReturnType<typeof useGT>,
): ReadonlyArray<TeamDriverOption> {
  return [{ value: "*", label: gt("All providers (*)") }, ...TEAM_PROVIDER_DRIVER_OPTIONS];
}

export function formatTeamDeliveryStrategyLabel(
  strategy: TeamProviderDeliveryStrategy,
  gt: ReturnType<typeof useGT>,
): string {
  switch (strategy) {
    case "proxy":
      return gt("Team proxy (API key)");
    case "token-lease":
      return gt("Token lease (OAuth)");
    case "remote-only":
      return gt("Remote environments only");
  }
}

export function formatTeamPrepromptScopeLabel(
  scope: TeamPrepromptInjectionScope,
  gt: ReturnType<typeof useGT>,
): string {
  return scope === "turn"
    ? gt("Every turn (compaction-proof)")
    : gt("Thread start (prefix-cached)");
}
