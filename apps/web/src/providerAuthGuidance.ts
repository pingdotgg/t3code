import type { ProviderKind } from "@t3tools/contracts";

export interface ProviderAuthGuidance {
  readonly summary: string;
  readonly detail: string;
}

export function getProviderAuthGuidance(provider: ProviderKind): ProviderAuthGuidance | null {
  if (provider !== "claudeCode") {
    return null;
  }

  return {
    summary: "Auth modes: Max/Pro sign-in or Claude-native API key mode.",
    detail:
      "Use `claude auth login` for Max/Pro, or configure API key mode outside T3 Code with `ANTHROPIC_API_KEY`, `apiKeyHelper`, or `forceLoginMethod`. T3 Code does not store Claude secrets.",
  };
}