import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";

const usage: ContextWindowSnapshot = {
  usedTokens: 64_000,
  totalProcessedTokens: 128_000,
  maxTokens: 128_000,
  remainingTokens: 64_000,
  usedPercentage: 50,
  remainingPercentage: 50,
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  lastUsedTokens: null,
  lastInputTokens: null,
  lastCachedInputTokens: null,
  lastOutputTokens: null,
  lastReasoningOutputTokens: null,
  toolUses: null,
  durationMs: null,
  compactsAutomatically: true,
  updatedAt: "2026-07-30T00:00:00.000Z",
};

describe("ContextWindowMeter", () => {
  it("renders the percentage inside the icon meter", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={usage} variant="icon" />);
    expect(markup).toContain(">50<");
    expect(markup).toContain("Context window 50% used");
  });

  it("renders a labeled variant for the metadata row", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter usage={usage} variant="labeled" providerDisplayName="Codex" />,
    );
    expect(markup).toContain(">50%<");
    expect(markup).toContain("Context window 50% used");
  });

  it("falls back to a formatted token value without a known maximum", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={{
          ...usage,
          maxTokens: null,
          usedPercentage: null,
          remainingTokens: null,
          remainingPercentage: null,
        }}
      />,
    );
    expect(markup).toContain(">64k<");
  });
});
