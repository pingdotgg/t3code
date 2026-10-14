import { describe, expect, it } from "@effect/vitest";
import { USAGE_CONTRACT_VERSION, UsageDay, type UsageSummary } from "@t3tools/contracts";
import { generationTokensPerSecond, mergeGenerationSpeedHistory } from "./generationSpeed.ts";

const measurement = {
  day: "2026-10-14",
  startedAt: "2026-10-14T10:00:00.000Z",
  provider: "codex" as const,
  model: "gpt-6.1",
  reasoningEffort: "high",
  outputTokens: 100,
  durationMs: 1_000,
  responses: 1,
};
function summary(sourceId: string, buckets = [measurement]): UsageSummary {
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: "2026-10-14T12:00:00.000Z",
    timeZone: "UTC",
    sinceDay: UsageDay.make("2026-10-14"),
    untilDay: UsageDay.make("2026-10-14"),
    buckets: [],
    sources: [],
    pricing: { status: "unavailable", source: "test", fetchedAt: null, knownModels: 0 },
    scanDurationMs: 0,
    generationSpeed: { sourceId, trackingStartedAt: "2026-10-14T09:00:00.000Z", buckets },
  };
}

describe("generation speed presentation", () => {
  it("weights rates by measured seconds and counts one source once across connections", () => {
    const first = summary("server-a");
    const second = summary("server-b", [{ ...measurement, durationMs: 10_000 }]);
    const merged = mergeGenerationSpeedHistory([
      { label: "Local", summary: first },
      { label: "Remote", summary: first },
      { label: "Other", summary: second },
    ]);
    expect(merged.tracking).toHaveLength(2);
    expect(merged.totals).toEqual({ outputTokens: 200, durationMs: 11_000, responses: 2 });
    expect(generationTokensPerSecond(merged.totals)).toBeCloseTo(18.18, 2);
    expect(merged.models).toHaveLength(1);
    expect(merged.periods).toHaveLength(1);
  });

  it("keeps effort and tier comparisons separate and applies provider filters", () => {
    const data = summary("server-a", [measurement, { ...measurement, reasoningEffort: "low" }]);
    const merged = mergeGenerationSpeedHistory([{ label: "Local", summary: data }]);
    expect(merged.models).toHaveLength(2);
    const filtered = mergeGenerationSpeedHistory(
      [{ label: "Local", summary: data }],
      new Set(["codex"]),
    );
    expect(filtered.models).toHaveLength(0);
    expect(filtered.totals.outputTokens).toBe(0);
    expect(filtered.tracking).toHaveLength(1);
  });

  it("supports older environments without inventing a tracking start or rate", () => {
    const old = summary("legacy");
    const { generationSpeed: _, ...legacy } = old;
    const merged = mergeGenerationSpeedHistory([
      { label: "Legacy", summary: legacy },
      { label: "Offline", summary: null },
    ]);
    expect(merged.tracking).toHaveLength(0);
    expect(generationTokensPerSecond(merged.totals)).toBeNull();
  });
});
