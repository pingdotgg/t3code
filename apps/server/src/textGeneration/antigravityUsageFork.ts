/**
 * Fork: background generation usage. The helper's session files are deleted
 * when it finishes, so the usage scan never sees the call. The ACP prompt
 * response carries the turn's usage instead.
 */
import type { UsageTokenTotals } from "@lathe/contracts";
import { totalsFromInclusiveInput } from "@lathe/provider-core/server/textGenerationUsageFork";
import { tokenCount, totalTokens } from "@lathe/provider-core/server/usage";
import type * as EffectAcpSchema from "effect-acp/compat";

import { antigravityUsageModelName } from "../provider/Drivers/antigravityUsageReader.ts";

export function antigravityPromptTotals(
  usage: EffectAcpSchema.PromptResponse["usage"],
): UsageTokenTotals | null {
  if (usage === undefined || usage === null) return null;
  const thought = tokenCount(usage.thoughtTokens);
  // ACP leaves the overlaps unspecified. This follows Gemini's counting, which
  // Antigravity reports through: cache reads inside input, thoughts outside output.
  const output = tokenCount(usage.outputTokens) + thought;
  const totals = totalsFromInclusiveInput({
    input: usage.inputTokens,
    cacheRead: usage.cachedReadTokens,
    cacheWrite: usage.cachedWriteTokens,
    output,
    reasoning: thought,
  });
  return totalTokens(totals) === 0 ? null : totals;
}

/** The name the usage scan records for a model, so the two price alike. */
export function antigravityReportedModel(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  model: string,
): string {
  const config = configOptions.find((option) => option.id === "model");
  const entries =
    config?.type === "select"
      ? config.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options))
      : [];
  const name = entries.find((entry) => entry.value === model)?.name ?? "";
  return antigravityUsageModelName(name) || model;
}
