import type {
  OrbitTaskInsights,
  OrbitTaskInsightsSummary,
} from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it } from "vite-plus/test";

import { insightByProvider } from "./tasksInsights.logic";

const EMPTY: OrbitTaskInsightsSummary = {
  tasks: null,
  merged: null,
  tokens: null,
  tokensPerMergedPr: null,
  leadTimeMs: null,
  deliveryTimeMs: null,
  deployWaitMs: null,
  prMergeWaitMs: null,
  prFirstPass: null,
  wastedShare: null,
  reviewRounds: null,
};

function insights(overrides: Partial<OrbitTaskInsights> = {}): OrbitTaskInsights {
  return {
    period: "30d",
    current: {
      ...EMPTY,
      merged: 22,
      tokens: 900,
      leadTimeMs: 100,
      prFirstPass: 0.58,
      wastedShare: 0.18,
      reviewRounds: 1.6,
    },
    previous: {
      ...EMPTY,
      merged: 20,
      tokens: 1000,
      leadTimeMs: 200,
      prFirstPass: 0.61,
      wastedShare: 0.16,
      reviewRounds: 1.8,
    },
    weekly: [],
    daily: [],
    hourly: [],
    byModel: [],
    ...overrides,
  };
}

describe("task insights by provider", () => {
  it("splits by provider from the model breakdown, weighting a provider's models by merges", () => {
    const row = (key: string, merged: number, tokensPerMergedPr: number | null) => ({
      key,
      label: key,
      tasks: merged,
      merged,
      tokensPerMergedPr,
      leadTimeMs: null,
    });
    const byModel = [
      row("claude-opus-5-5", 3, 100),
      row("gpt-5.5-codex", 2, 50),
      row("claude-sonnet-5-5", 1, 200),
      row("some-local-model", 4, 10),
    ];
    expect(insightByProvider(insights({ byModel }), "tokens")).toEqual([
      { provider: "codex", value: 50 },
      { provider: "claude", value: 125 },
    ]);
    expect(insightByProvider(insights({ byModel }), "completed")).toEqual([
      { provider: "codex", value: 2 },
      { provider: "claude", value: 4 },
    ]);
    expect(insightByProvider(insights({ byModel }), "delivery")).toEqual([
      { provider: "codex", value: null },
      { provider: "claude", value: null },
    ]);
    expect(insightByProvider(insights({ byModel }), "wasted")).toEqual([]);
  });
});
