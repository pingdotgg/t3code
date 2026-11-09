import { useAtomValue } from "@effect/atom-react";
import type { UsageProviderKind } from "@t3tools/contracts";
import {
  firstProviderOrderSettings,
  providerDriverOrder,
  sortByProviderOrder,
} from "@t3tools/shared/providerOrder";

import { environmentPresentations } from "../../state/presentation";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

export const PROVIDER_ORDER: readonly UsageProviderKind[] = [
  "codex",
  "claude",
  "grok",
  "cursor",
  "opencode",
  "antigravity",
  "pi",
  "muse",
];

export function usageProviderKind(driver: string): UsageProviderKind | null {
  if (driver === "claudeAgent") return "claude";
  return PROVIDER_ORDER.find((kind) => kind === driver) ?? null;
}

/** Driver kinds from the first environment with a saved order in Settings → Providers. */
export function useSavedDriverOrder(): readonly string[] {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const settings = firstProviderOrderSettings(
    [...presentations.values()].map((presentation) => presentation.serverConfig?.settings),
  );
  return settings === null ? [] : providerDriverOrder(settings);
}

/** Null until an environment saves an order; each section then keeps its own ranking. */
export function useSavedUsageProviderOrder(): readonly UsageProviderKind[] | null {
  const driverOrder = useSavedDriverOrder();
  if (driverOrder.length === 0) return null;
  return sortByProviderOrder(PROVIDER_ORDER, driverOrder, (kind) =>
    kind === "claude" ? "claudeAgent" : kind,
  );
}

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok Build",
  cursor: "Cursor",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  pi: "Pi",
  muse: "Muse Code",
};

export function useProviderColors(): Record<UsageProviderKind, string> {
  const { themeAppearance: scheme } = useAppearancePreferences();
  return {
    claude: "#d97757",
    codex: scheme === "dark" ? "#e6e6e6" : "#3c3c43",
    grok: scheme === "dark" ? "#a1a1aa" : "#52525b",
    cursor: "#8b8b8b",
    opencode: "#5b9bbd",
    antigravity: "#8c7bd1",
    pi: "#4d9f8a",
    muse: "#0866ff",
  };
}

export function useUsageMixColors() {
  const { themeAppearance: scheme } = useAppearancePreferences();
  const dark = scheme === "dark";
  return {
    input: dark ? "#737373" : "#848484",
    cacheRead: dark ? "#282828" : "#c0c0c0",
    cacheWrite: dark ? "#949494" : "#6d6d6d",
    output: dark ? "#e6e6e6" : "#3c3c43",
    other: dark ? "#494949" : "#a3a3a3",
    standard: dark ? "#313131" : "#b8b8b8",
    fast: dark ? "#838383" : "#797979",
    ultrafast: dark ? "#e6e6e6" : "#3c3c43",
  };
}
