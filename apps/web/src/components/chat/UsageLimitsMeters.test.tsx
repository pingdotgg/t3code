import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderUsageWindow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { UsageLimitsMeters } from "./UsageLimitsMeters";

const window = (id: string, label: string, usedPercent: number): ProviderUsageWindow => ({
  id,
  label,
  usedPercent,
  resetsAt: null,
});

const CLAUDE_WINDOWS = [
  window("session", "Session", 42),
  window("weekly", "Weekly", 61),
  window("weekly-fable", "Fable", 12),
];

const render = (props: Partial<Parameters<typeof UsageLimitsMeters>[0]> = {}) =>
  renderToStaticMarkup(
    <UsageLimitsMeters
      windows={CLAUDE_WINDOWS}
      updatedAt={null}
      compact={false}
      providerDisplayName="Claude"
      onRequestRefresh={() => {}}
      {...props}
    />,
  );

const countMeterButtons = (markup: string) =>
  markup.match(/aria-label="[^"]* usage /g)?.length ?? 0;

describe("UsageLimitsMeters", () => {
  it("renders nothing at all when the provider reports no windows", () => {
    // Not a placeholder: switching to a provider without usage must not
    // shift the composer's action row.
    expect(render({ windows: [] })).toBe("");
  });

  it("renders one circle per window in full mode", () => {
    expect(countMeterButtons(render())).toBe(3);
  });

  it("collapses to a single circle in compact mode", () => {
    expect(countMeterButtons(render({ compact: true }))).toBe(1);
  });

  it("shows the bucket closest to running out when collapsed", () => {
    const markup = render({ compact: true });
    expect(markup).toContain('aria-label="Weekly usage 61% used"');
  });

  it("puts the percentage inside the ring as bare digits", () => {
    // The ring leaves ~13px of clear space; a `%` sign would not fit.
    const markup = render({ windows: [window("session", "Session", 42)] });
    expect(markup).toContain(">42</span>");
    expect(markup).not.toContain(">42%</span>");
  });

  it("tightens tracking only when the digits reach three characters", () => {
    expect(render({ windows: [window("session", "Session", 99)] })).not.toContain(
      "tracking-tighter",
    );
    expect(render({ windows: [window("session", "Session", 100)] })).toContain("tracking-tighter");
  });
});
