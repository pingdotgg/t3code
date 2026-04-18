import type { ServerProviderUsageLimits } from "@t3tools/contracts";

import { clampPercent } from "./providerUsageLimits.ts";

export function runtimeUsageToProviderUsageLimits(input: {
  readonly source: "cursorAcp" | "opencodeManaged";
  readonly checkedAt: string;
  readonly usedTokens: number;
  readonly maxTokens: number;
  readonly label?: string;
}): ServerProviderUsageLimits | undefined {
  if (
    !Number.isFinite(input.usedTokens) ||
    !Number.isFinite(input.maxTokens) ||
    input.usedTokens < 0 ||
    input.maxTokens <= 0
  ) {
    return undefined;
  }

  const rawPercent = (input.usedTokens / input.maxTokens) * 100;
  if (!Number.isFinite(rawPercent)) {
    return undefined;
  }

  return {
    source: input.source,
    available: true,
    checkedAt: input.checkedAt,
    windows: [
      {
        kind: "session",
        label: input.label?.trim() || "Session",
        usedPercent: clampPercent(rawPercent),
      },
    ],
  };
}
