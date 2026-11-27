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

function mountTimeline(html: string) {
  const container = document.createElement("div");
  container.style.cssText = "height: 200px; width: 300px; overflow: auto";
  container.innerHTML = html;
  document.body.append(container);
  return { container, [Symbol.dispose]: () => container.remove() };
}

const painted = () => [...(CSS.highlights.get("t3-thread-find") ?? [])] as Range[];
const paintedIn = (element: Element) =>
  painted().filter((range) => element.contains(range.startContainer)).length;

it("paints only matches near the viewport plus the active one, in a row with more matches than a call can take as arguments", async () => {
  const count = 200_000;
  const onActiveRange = vi.fn<(range: Range | null) => void>();
  using timeline = mountTimeline(
    `<div data-timeline-row-id="row"><div data-thread-find-text>${"e x".repeat(count)}</div></div>`,
  );
  await using _screen = await render(
    <Highlights
      container={timeline.container}
      query="e"
      activeRowId="row"
      activeOccurrence={count - 1}
      onActiveRange={onActiveRange}
    />,
  );
  const visible = painted();
  expect(visible.length).toBeGreaterThan(0);
  expect(visible.length).toBeLessThan(5_000);
  expect(Math.max(...visible.map((range) => range.startOffset))).toBeLessThan(count);
  expect(CSS.highlights.get("t3-thread-find-active")?.size).toBe(1);
  expect(onActiveRange.mock.lastCall?.[0]?.startOffset).toBe((count - 1) * 3);

  timeline.container.scrollTop = timeline.container.scrollHeight;
  await vi.waitFor(() =>
    expect(Math.max(...painted().map((range) => range.startOffset))).toBe((count - 2) * 3),
  );
  expect(painted().length).toBeLessThan(5_000);
});

it("paints every match near the viewport when cells lay text out in a different order than the DOM", async () => {
  using timeline = mountTimeline(
    `<div data-timeline-row-id="row"><div data-thread-find-text><table style="width: 100%"><tr>
       <td style="vertical-align: top">${"e x ".repeat(5_000)}</td>
       <td style="vertical-align: top">${"e x ".repeat(5_000)}</td>
     </tr></table></div></div>`,
  );
  const cells = [...timeline.container.querySelectorAll("td")];
  const ranges = collectThreadFindRanges(timeline.container, "e");
  const key = (range: Range) =>
    `${cells.indexOf(range.startContainer.parentElement as HTMLTableCellElement)}:${range.startOffset}`;
  const missing = () => {
    const viewport = timeline.container.getBoundingClientRect();
    const [top, bottom] = [viewport.top - viewport.height, viewport.bottom + viewport.height];
    const shown = new Set(painted().map(key));
    return ranges.filter(({ range }) => {
      const rect = range.getBoundingClientRect();
      return rect.bottom >= top && rect.top <= bottom && !shown.has(key(range));
    }).length;
  };
  await using _screen = await render(
    <Highlights
      container={timeline.container}
      query="e"
      activeRowId={null}
      activeOccurrence={0}
      onActiveRange={() => {}}
    />,
  );
  expect(missing()).toBe(0);

  timeline.container.scrollTop = 1_000;
  await vi.waitFor(() => expect(missing()).toBe(0));
  expect(painted().length).toBeLessThan(ranges.length / 2);
});

it("skips a hidden block's matches without measuring each one", async () => {
  using timeline = mountTimeline(
    `<div data-timeline-row-id="row"><div data-thread-find-text>
       <div style="display: none">${"e x ".repeat(10_000)}</div><p>e</p>
     </div></div>`,
  );
  const visible = timeline.container.querySelector("p")!;
  using measure = vi.spyOn(Range.prototype, "getBoundingClientRect");
  await using _screen = await render(
    <Highlights
      container={timeline.container}
      query="e"
      activeRowId={null}
      activeOccurrence={0}
      onActiveRange={() => {}}
    />,
  );
  expect([painted().length, paintedIn(visible)]).toEqual([1, 1]);
  expect(measure.mock.calls.length).toBeLessThan(100);
});

it("registers a row's matches only while it is near the viewport, and again after its text changes", async () => {
  using timeline = mountTimeline(
    `<div data-timeline-row-id="near"><div data-thread-find-text>e e e</div></div>
     <div style="height: 5000px"></div>
     <div data-timeline-row-id="far"><div data-thread-find-text>e e</div></div>`,
  );
  const [near, far] = [...timeline.container.querySelectorAll("[data-thread-find-text]")];
  const onActiveRange = vi.fn<(range: Range | null) => void>();
  await using _screen = await render(
    <Highlights
      container={timeline.container}
      query="e"
      activeRowId="far"
      activeOccurrence={1}
      onActiveRange={onActiveRange}
    />,
  );
  expect([paintedIn(near!), paintedIn(far!)]).toEqual([3, 0]);
  expect(CSS.highlights.get("t3-thread-find-active")?.size).toBe(1);
  expect(far!.contains(onActiveRange.mock.lastCall?.[0]?.startContainer ?? null)).toBe(true);

  near!.append(" e");
  await vi.waitFor(() => expect(paintedIn(near!)).toBe(4));

  timeline.container.scrollTop = timeline.container.scrollHeight;
  await vi.waitFor(() => expect([paintedIn(near!), paintedIn(far!)]).toEqual([0, 1]));
});

it("paints a row's matches once the hidden wrapper around it is revealed", async () => {
  using timeline = mountTimeline(
    `<div id="wrap" hidden><div data-timeline-row-id="row"><div data-thread-find-text>e e</div></div></div>`,
  );
  const text = timeline.container.querySelector("[data-thread-find-text]")!;
  await using _screen = await render(
    <Highlights
      container={timeline.container}
      query="e"
      activeRowId={null}
      activeOccurrence={0}
      onActiveRange={() => {}}
    />,
  );
  expect(paintedIn(text)).toBe(0);

  timeline.container.querySelector("#wrap")!.removeAttribute("hidden");
  await vi.waitFor(() => expect(paintedIn(text)).toBe(2));
});
