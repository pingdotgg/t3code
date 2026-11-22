import type { ProviderDriverKind } from "@t3tools/contracts";

export const DEFAULT_AUTONOMOUS_MAX_TURNS = 25;
export const DEFAULT_AUTONOMOUS_MAX_TOKENS = 200_000;

export type PrimeAgentQuickCommandKind = "goal" | "autonomous" | "refine";

export interface PrimeAgentAutonomousBudget {
  readonly maxTurns?: string | number | undefined;
  readonly maxTokens?: string | number | undefined;
}

function parsePositiveBudget(raw: string | number | undefined): number | undefined {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
  }
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function formatPrimeAgentQuickCommand(
  kind: PrimeAgentQuickCommandKind,
  budget?: PrimeAgentAutonomousBudget,
): string {
  switch (kind) {
    case "goal":
      return "/goal";
    case "refine":
      return "/refine";
    case "autonomous": {
      const parts = ["/autonomous"];
      const turns = parsePositiveBudget(budget?.maxTurns);
      const tokens = parsePositiveBudget(budget?.maxTokens);
      if (turns !== undefined) parts.push(`--max-turns ${turns}`);
      if (tokens !== undefined) parts.push(`--max-tokens ${tokens}`);
      return parts.join(" ");
    }
  }
}

const LEADING_PRIME_COMMAND_PATTERN =
  /^\/(?:goal|refine|autonomous(?:\s+--(?:max-turns|max-tokens)\s+\d+)*)(?:\s+|$)/i;

/**
 * Replaces any existing leading /goal, /autonomous, or /refine command while
 * preserving the rest of the user's draft prompt text.
 */
export function applyPrimeAgentCommandToPrompt(
  prompt: string,
  kind: PrimeAgentQuickCommandKind,
  budget?: PrimeAgentAutonomousBudget,
): string {
  const prefix = formatPrimeAgentQuickCommand(kind, budget);
  const trimmed = prompt.trimStart();
  const remainder = trimmed.replace(LEADING_PRIME_COMMAND_PATTERN, "").trimStart();
  if (remainder.length === 0) {
    return kind === "refine" ? prefix : `${prefix} `;
  }
  return `${prefix} ${remainder}`;
}

export function activePrimeAgentCommandInPrompt(prompt: string): PrimeAgentQuickCommandKind | null {
  const trimmed = prompt.trimStart().toLowerCase();
  if (trimmed.startsWith("/goal")) return "goal";
  if (trimmed.startsWith("/autonomous")) return "autonomous";
  if (trimmed.startsWith("/refine")) return "refine";
  return null;
}

export function shouldWarnPrimeAgentLocalHost(input: {
  readonly provider: ProviderDriverKind | null | undefined;
  readonly isCloudSandbox: boolean;
}): boolean {
  return input.provider === "primeAgent" && !input.isCloudSandbox;
}
