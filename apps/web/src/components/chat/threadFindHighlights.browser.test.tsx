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

it("paints every match in a large row and preserves occurrence selection", async () => {
  const count = 200_000;
  const container = row("e x".repeat(count));
  const text = container.querySelector("[data-thread-find-text]")!.firstChild!;
  const onActiveRange = vi.fn<(range: Range | null) => void>();
  const props = {
    container,
    query: "e",
    activeRowId: "row",
    activeOccurrence: count - 1,
    onActiveRange,
  };
  await using screen = await render(<Highlights {...props} />);
  const inactive = CSS.highlights.get("t3-thread-find")!;
  const active = CSS.highlights.get("t3-thread-find-active")!;
  expect(inactive.size).toBe(count - 1);
  expect(active.size).toBe(1);
  const selected = onActiveRange.mock.lastCall![0]!;
  expect(selected.startContainer).toBe(text);
  expect(selected.startOffset).toBe((count - 1) * 3);
  expect(selected.toString()).toBe("e");
  expect(Array.from(inactive, (range) => [range.startOffset, range.endOffset])).toEqual(
    Array.from({ length: count - 1 }, (_, index) => [index * 3, index * 3 + 1]),
  );

  await screen.rerender(<Highlights {...props} activeOccurrence={0} />);
  expect(active.size).toBe(1);
  expect(onActiveRange.mock.lastCall?.[0]?.startOffset).toBe(0);
  expect(inactive.has(selected)).toBe(true);
  await screen.unmount();
  expect(CSS.highlights.has("t3-thread-find")).toBe(false);
  expect(CSS.highlights.has("t3-thread-find-active")).toBe(false);
});
