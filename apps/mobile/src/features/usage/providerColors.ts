import type { UsageProviderKind } from "@t3tools/contracts";

export function providerColors(scheme: "light" | "dark"): Record<UsageProviderKind, string> {
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
