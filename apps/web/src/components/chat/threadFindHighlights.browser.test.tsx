import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

import { collectThreadFindRanges, useThreadFindHighlights } from "./threadFindHighlights";

function row(html: string) {
  const container = document.createElement("div");
  container.innerHTML = `<div data-timeline-row-id="row"><div data-thread-find-text>${html}</div></div>`;
  return container;
}

describe("collectThreadFindRanges", () => {
  it("finds matches split across inline token spans, in order", () => {
    const container = row(
      "<pre><code><span>con</span><span>st</span> a = <span>c</span>onst; const</code></pre>",
    );
    const ranges = collectThreadFindRanges(container, "const");
    expect(ranges.map((match) => [match.occurrence, match.range.toString()])).toEqual([
      [0, "const"],
      [1, "const"],
      [2, "const"],
    ]);
  });
});

function Highlights(props: Parameters<typeof useThreadFindHighlights>[0]) {
  useThreadFindHighlights(props);
  return null;
}

it("paints every match when one row has more matches than a call can take as arguments", async () => {
  const count = 200_000;
  const onActiveRange = vi.fn<(range: Range | null) => void>();
  await using _screen = await render(
    <Highlights
      container={row("e x".repeat(count))}
      query="e"
      activeRowId="row"
      activeOccurrence={count - 1}
      onActiveRange={onActiveRange}
    />,
  );
  expect(CSS.highlights.get("t3-thread-find")?.size).toBe(count - 1);
  expect(CSS.highlights.get("t3-thread-find-active")?.size).toBe(1);
  expect(onActiveRange.mock.lastCall?.[0]?.startOffset).toBe((count - 1) * 3);
});
