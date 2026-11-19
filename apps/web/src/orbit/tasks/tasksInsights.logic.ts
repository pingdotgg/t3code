import type { OrbitTaskInsights, InsightId } from "@t3tools/client-runtime/orbit-gateway";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";

import { orbitAgentDriverKind } from "./taskDetail.logic";

// The insight numbers themselves are shared with the phone (`@t3tools/client-runtime/orbit-gateway`).
// The provider split names providers the way the desktop does.

/** Orbit's provider names, by CLI. */
export type InsightProvider = "codex" | "claude" | "gemini";
const PROVIDER_ORDER: ReadonlyArray<InsightProvider> = ["codex", "claude", "gemini"];

/** Orbit breaks insights down by model; the board names the provider behind it. */
function insightProviderOf(model: string): InsightProvider | null {
  const name = model.toLowerCase();
  if (/claude|opus|sonnet|haiku/.test(name)) return "claude";
  if (/gemini/.test(name)) return "gemini";
  if (/codex|gpt|^o\d/.test(name)) return "codex";
  return null;
}

/** Conn's name for the provider, else its CLI name capitalized. */
export function insightProviderName(provider: InsightProvider): string {
  const driverKind = orbitAgentDriverKind(provider);
  const known = driverKind ? PROVIDER_DISPLAY_NAMES[driverKind] : undefined;
  return known ?? `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
}

/**
 * The insight per provider, from Orbit's model breakdown, in a fixed provider order. Models of one
 * provider combine weighted by their merged tasks. Empty for numbers the breakdown lacks.
 */
export function insightByProvider(
  insights: OrbitTaskInsights | null,
  id: InsightId,
): ReadonlyArray<{ readonly provider: InsightProvider; readonly value: number | null }> {
  const field =
    id === "completed"
      ? "merged"
      : id === "tokens"
        ? "tokensPerMergedPr"
        : id === "delivery"
          ? "leadTimeMs"
          : null;
  if (insights === null || field === null || insights.byModel.length === 0) return [];
  return PROVIDER_ORDER.flatMap((provider) => {
    const rows = insights.byModel.filter((row) => insightProviderOf(row.key) === provider);
    if (rows.length === 0) return [];
    if (field === "merged") {
      return [{ provider, value: rows.reduce((sum, row) => sum + (row.merged ?? 0), 0) }];
    }
    const weighted = rows.flatMap((row) =>
      row[field] === null || !row.merged ? [] : [{ value: row[field]!, weight: row.merged }],
    );
    const weight = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    return [
      {
        provider,
        value:
          weight === 0
            ? null
            : weighted.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / weight,
      },
    ];
  });
}
