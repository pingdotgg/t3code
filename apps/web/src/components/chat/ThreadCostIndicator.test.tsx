import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ThreadCostSnapshot } from "../../state/threadCost";
import { formatThreadCostUsd, ThreadCostIndicator } from "./ThreadCostIndicator";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ openOnHover, render }: { openOnHover: boolean; render: ReactNode }) => (
    <div data-open-on-hover={openOnHover}>{render}</div>
  ),
}));

const cost: ThreadCostSnapshot = {
  costUsd: 4.25,
  cacheWriteUsd: 1.5,
  cacheReadUsd: 2,
  freshUsd: 0.75,
  providerReportedUsd: 0,
  uncachedInputTokens: 100,
  cachedInputTokens: 200,
  cacheCreationTokens: 300,
  outputTokens: 400,
};

describe("ThreadCostIndicator", () => {
  it("shows the current total and opens the component breakdown on hover", () => {
    const markup = renderToStaticMarkup(<ThreadCostIndicator cost={cost} />);

    expect(markup).toContain('data-open-on-hover="true"');
    expect(markup).toContain('data-slot="button"');
    expect(markup).toContain('aria-label="Thread API cost $4.25"');
    expect(markup).toContain("Cache writes, estimated");
    expect(markup).toContain("Cache reads");
    expect(markup).toContain("Fresh input + output");
    expect(markup).toContain("300 tokens");
  });

  it("keeps sub-cent thread costs readable", () => {
    expect(formatThreadCostUsd(0)).toBe("$0.00");
    expect(formatThreadCostUsd(0.0042)).toBe("$0.0042");
    expect(formatThreadCostUsd(1.234)).toBe("$1.23");
  });

  it("reports unavailable cache-write pricing and provider-reported cost", () => {
    const markup = renderToStaticMarkup(
      <ThreadCostIndicator cost={{ ...cost, cacheWriteUsd: null, providerReportedUsd: 1.25 }} />,
    );

    expect(markup).toContain("Unavailable");
    expect(markup).toContain("Provider-reported remainder");
  });
});
