export const CLAUDE_PROVIDER_ICON_CLASS_NAME = "text-[#d97757]";
export const GEMINI_PROVIDER_ICON_CLASS_NAME = "text-[#4f8df7]";

export type ProviderBrandKey = "claudeAgent" | "codex" | "gemini" | "cursor" | "opencode";

export function normalizeProviderBrandKey(
  provider: string | null | undefined,
): ProviderBrandKey | null {
  switch (provider) {
    case "claudeAgent":
    case "codex":
    case "gemini":
      return provider;
    case "cursor":
    case "cursorCli":
    case "cursorAgent":
    case "cursor-agent":
      return "cursor";
    case "opencode":
    case "openCode":
    case "openCodeCli":
    case "opencodeCli":
      return "opencode";
    default:
      return null;
  }
}

export function providerIconClassName(
  provider: string | null | undefined,
  fallbackClassName: string,
): string {
  switch (normalizeProviderBrandKey(provider)) {
    case "claudeAgent":
      return CLAUDE_PROVIDER_ICON_CLASS_NAME;
    case "gemini":
      return GEMINI_PROVIDER_ICON_CLASS_NAME;
    default:
      return fallbackClassName;
  }
}
