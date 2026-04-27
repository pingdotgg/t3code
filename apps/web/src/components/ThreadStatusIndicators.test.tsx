import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ThreadStatusPill } from "./Sidebar.logic";
import { prStatusIndicator, ThreadStatusLabel } from "./ThreadStatusIndicators";

function renderStatus(status: ThreadStatusPill, compact = false) {
  return renderToStaticMarkup(<ThreadStatusLabel compact={compact} status={status} />);
}

describe("ThreadStatusLabel", () => {
  it("renders the pixel grid loader for active work", () => {
    const markup = renderStatus(
      {
        label: "Working",
        toneClass: "text-sky-600",
        glyph: "grid",
        pulse: true,
      },
      true,
    );

    expect(markup).toContain('data-slot="pixel-grid-loader"');
    expect(markup).toContain('data-status-glyph="grid"');
    expect(markup).toContain('data-pixel-grid-preset="spiral-cw"');
    expect(markup.match(/data-slot="pixel-grid-loader-cell"/g)).toHaveLength(9);
  });

  it("renders lucide glyphs for settled statuses", () => {
    const markup = renderToStaticMarkup(
      <>
        <ThreadStatusLabel
          compact
          status={{
            label: "Pending Approval",
            toneClass: "text-amber-600",
            glyph: "circle-alert",
            pulse: false,
          }}
        />
        <ThreadStatusLabel
          compact
          status={{
            label: "Awaiting Input",
            toneClass: "text-indigo-600",
            glyph: "circle-question-mark",
            pulse: false,
          }}
        />
        <ThreadStatusLabel
          compact
          status={{
            label: "Plan Ready",
            toneClass: "text-violet-600",
            glyph: "file-text",
            pulse: false,
          }}
        />
        <ThreadStatusLabel
          compact
          status={{
            label: "Completed",
            toneClass: "text-emerald-600",
            glyph: "check-check",
            pulse: false,
          }}
        />
      </>,
    );

    expect(markup).toContain('data-status-glyph="circle-alert"');
    expect(markup).toContain("lucide-circle-alert");
    expect(markup).toContain('data-status-glyph="circle-question-mark"');
    expect(markup).toContain("lucide-circle-question-mark");
    expect(markup).toContain('data-status-glyph="file-text"');
    expect(markup).toContain("lucide-file-text");
    expect(markup).toContain('data-status-glyph="check-check"');
    expect(markup).toContain("lucide-check-check");
  });
});

describe("prStatusIndicator", () => {
  it("maps PR states to distinct lucide icons with semantic tones", () => {
    const open = prStatusIndicator({
      state: "open",
      number: 12,
      title: "Open",
      url: "https://example.com/open",
    } as never);
    const closed = prStatusIndicator({
      state: "closed",
      number: 13,
      title: "Closed",
      url: "https://example.com/closed",
    } as never);
    const merged = prStatusIndicator({
      state: "merged",
      number: 14,
      title: "Merged",
      url: "https://example.com/merged",
    } as never);
    const OpenIcon = open!.icon;
    const ClosedIcon = closed!.icon;
    const MergedIcon = merged!.icon;

    expect(open?.toneClass).toContain("text-emerald-600");
    expect(renderToStaticMarkup(<OpenIcon />)).toContain("lucide-git-pull-request");

    expect(closed?.toneClass).toContain("text-zinc-500");
    expect(renderToStaticMarkup(<ClosedIcon />)).toContain("lucide-git-pull-request-closed");

    expect(merged?.toneClass).toContain("text-violet-600");
    expect(renderToStaticMarkup(<MergedIcon />)).toContain("lucide-git-merge");
  });
});
