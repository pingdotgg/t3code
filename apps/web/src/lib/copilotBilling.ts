const COPILOT_MODEL_MULTIPLIER_BY_SLUG = {
  "claude-sonnet-4.6": 1,
  "claude-sonnet-4.5": 1,
  "claude-haiku-4.5": 0.33,
  "claude-opus-4.6": 3,
  "claude-opus-4.6-fast": 30,
  "claude-opus-4.5": 3,
  "claude-sonnet-4": 1,
  "gemini-3-pro-preview": 1,
  "gpt-5.4": 1,
  "gpt-5.3-codex": 1,
  "gpt-5.2-codex": 1,
  "gpt-5.2": 1,
  "gpt-5.1-codex-max": 1,
  "gpt-5.1-codex": 1,
  "gpt-5.1": 1,
  "gpt-5.1-codex-mini": 0.33,
  "gpt-5-mini": 0,
  "gpt-4.1": 0,
} as const satisfies Record<string, number>;

export const COPILOT_PREMIUM_REQUEST_OVERAGE_USD = 0.04;

function formatMultiplierValue(multiplier: number): string {
  if (Number.isInteger(multiplier)) {
    return `${multiplier}x`;
  }
  return `${multiplier.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}x`;
}

export function getCopilotModelMultiplier(model: string): number | null {
  return COPILOT_MODEL_MULTIPLIER_BY_SLUG[model as keyof typeof COPILOT_MODEL_MULTIPLIER_BY_SLUG] ?? null;
}

export function getCopilotEstimatedOverageUsd(model: string): number | null {
  const multiplier = getCopilotModelMultiplier(model);
  if (multiplier === null) return null;
  return Number((multiplier * COPILOT_PREMIUM_REQUEST_OVERAGE_USD).toFixed(4));
}

export function formatUsdAmount(amount: number): string {
  if (Number.isInteger(amount * 100)) {
    return `$${amount.toFixed(2)}`;
  }
  if (amount >= 1) {
    return `$${amount.toFixed(2)}`;
  }
  if (amount >= 0.01) {
    return `$${amount.toFixed(3)}`;
  }
  return `$${amount.toFixed(4)}`;
}

export function formatCopilotRequestCost(model: string): string | null {
  const multiplier = getCopilotModelMultiplier(model);
  if (multiplier === null) {
    return null;
  }
  if (multiplier === 0) {
    return "0x · included on paid plans";
  }
  return `${formatMultiplierValue(multiplier)} · ~${formatUsdAmount(
    getCopilotEstimatedOverageUsd(model) ?? 0,
  )}`;
}
