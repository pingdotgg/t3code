import type { ProviderKind, ServerProviderAuthStatus } from "@t3tools/contracts";

export interface ProviderAuthGuidance {
  readonly summary: string;
  readonly detail: string;
}

export const CLAUDE_CODE_GETTING_STARTED_DOCS_URL =
  "https://docs.anthropic.com/en/docs/claude-code/getting-started";

export function getProviderAuthGuidance(
  provider: ProviderKind,
  authStatus?: ServerProviderAuthStatus | null,
): ProviderAuthGuidance | null {
  if (provider !== "claudeCode") {
    return null;
  }

  return {
    summary:
      authStatus === "unauthenticated"
        ? "Sign in with `claude auth login`, or use Claude API-key mode outside T3 Code."
        : "Claude supports native sign-in and external API-key mode.",
    detail:
      "T3 Code does not store Claude secrets. Use `claude auth login`, or configure API-key mode with environment/config outside the app.",
  };
}
