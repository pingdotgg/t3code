export type ProviderIconKind = "claude" | "opencode" | "opencode2" | "openai";

export function providerIconKind(provider: string | null | undefined): ProviderIconKind {
  switch (provider) {
    case "claudeAgent":
      return "claude";
    case "opencode":
      return "opencode";
    case "opencode2":
      return "opencode2";
    default:
      return "openai";
  }
}

export function providerIconPalette(
  _kind: ProviderIconKind,
  isDarkMode: boolean,
): "light" | "dark" {
  return isDarkMode ? "dark" : "light";
}
