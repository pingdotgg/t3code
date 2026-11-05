import type { UsageProviderKind } from "@t3tools/contracts";
import type { ThemeAppearance } from "@t3tools/shared/themePalettes";
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

// Checked for colour-vision separation in PROVIDER_ORDER (the chart's stacking order) and >= 3:1
// against the grouped card in both themes. Cursor stays a neutral to match its monochrome mark.
const PROVIDER_COLORS = {
  light: {
    codex: "#0f9a72",
    claude: "#d4693f",
    grok: "#6d4fd6",
    cursor: "#52525b",
    opencode: "#b58500",
    antigravity: "#c84594",
    pi: "#5a8f1f",
    muse: "#1a8fd8",
  },
  dark: {
    codex: "#1fa883",
    claude: "#d6704c",
    grok: "#8261e8",
    cursor: "#74747c",
    opencode: "#c08a00",
    antigravity: "#d158a6",
    pi: "#6aa339",
    muse: "#2b9be8",
  },
} as const satisfies Record<ThemeAppearance, Record<UsageProviderKind, string>>;

export function useProviderColors(): Record<UsageProviderKind, string> {
  return PROVIDER_COLORS[useAppearancePreferences().themeAppearance];
}

// One blue ramp ordered by price per token: darker in light theme, brighter in dark theme, means
// a pricier token. Other has no split, so it stays neutral.
const MIX_RAMP = {
  light: ["#6da7ec", "#2a78d6", "#1c5cab", "#104281"],
  dark: ["#1c5cab", "#3987e5", "#6da7ec", "#9ec5f4"],
} as const;

export function useUsageMixColors() {
  const { themeAppearance } = useAppearancePreferences();
  const [cheapest, cheap, dear, dearest] = MIX_RAMP[themeAppearance];
  return {
    cacheRead: cheapest,
    input: cheap,
    cacheWrite: dear,
    output: dearest,
    other: themeAppearance === "dark" ? "#5c5c5c" : "#a3a3a3",
    standard: cheapest,
    fast: cheap,
    ultrafast: dearest,
  };
}
