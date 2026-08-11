import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderUsageStripItem } from "./ProviderUsageStrip.logic";
import { ProviderUsageStripView } from "./ProviderUsageStrip";

function item(input: {
  readonly id: string;
  readonly percentage: number | null;
}): ProviderUsageStripItem {
  return {
    instanceId: ProviderInstanceId.make(input.id),
    driver: ProviderDriverKind.make("codex"),
    displayName: input.id === "codex-work" ? "Work Codex" : "Personal Codex",
    percentage: input.percentage,
    headlineLabel: input.percentage === null ? null : "Weekly limit",
    snapshot: null,
  };
}

describe("ProviderUsageStripView", () => {
  it("renders a stable one-line logo/value strip without visible provider names or headings", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageStripView
        canOperate={false}
        isSmallScreen={false}
        items={[
          item({ id: "codex-personal", percentage: 100 }),
          item({ id: "codex-work", percentage: null }),
        ]}
        onConsumeReset={async () => null}
      />,
    );

    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("whitespace-nowrap");
    expect(markup).toContain(">100%</span>");
    expect(markup).toContain(">—</span>");
    expect(markup).toContain("tabular-nums");
    expect(markup.match(/<svg/g)).toHaveLength(2);
    expect(markup).not.toContain(">Personal Codex<");
    expect(markup).not.toContain(">Work Codex<");
    expect(markup).not.toContain("Provider usage");
  });

  it("labels available and unavailable buttons with the instance and window", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageStripView
        canOperate={false}
        isSmallScreen
        items={[
          item({ id: "codex-personal", percentage: 100 }),
          item({ id: "codex-work", percentage: null }),
        ]}
        onConsumeReset={async () => null}
      />,
    );

    expect(markup).toContain('aria-label="Personal Codex: 100% remaining, Weekly limit"');
    expect(markup).toContain('aria-label="Work Codex: usage remaining unavailable"');
  });
});
