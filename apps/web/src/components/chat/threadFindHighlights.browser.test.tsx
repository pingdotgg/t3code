import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import { collectThreadFindRanges, useThreadFindHighlights } from "./threadFindHighlights";

function Probe(props: Parameters<typeof useThreadFindHighlights>[0]) {
  useThreadFindHighlights(props);
  return null;
}

const activeRanges = () => [
  ...(CSS.highlights.get("t3-thread-find-active") as unknown as Set<Range>),
];

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function setup() {
  using stack = new DisposableStack();
  stack.use(stubGlobal("CSS", { highlights: new Map() }));
  stack.use(
    stubGlobal(
      "Highlight",
      class extends Set<Range> {
        constructor(...ranges: Range[]) {
          super(ranges);
        }
      },
    ),
  );
  const container = document.createElement("div");
  container.innerHTML =
    '<div data-timeline-row-id="first"><p data-thread-find-text>COD4 and COD4</p></div>' +
    '<div data-timeline-row-id="second"><p data-thread-find-text>COD4</p></div>';
  document.body.append(container);
  stack.defer(() => container.remove());
  const environment = stack.move();
  return { container, onActiveRange: vi.fn(), [Symbol.dispose]: () => environment.dispose() };
}

describe("find highlight caching", () => {
  it("checks only the old and new occurrence when cycling a message with many clipped matches", async () => {
    using find = setup();
    const { container, onActiveRange } = find;
    container.innerHTML =
      '<div data-timeline-row-id="first"><div data-thread-find-fold><p data-thread-find-text>' +
      "COD4 ".repeat(1500) +
      "</p></div></div>";
    const bounds = vi.fn(() => new DOMRect(0, 0, 40, 20));
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: bounds,
    });
    using _bounds = {
      [Symbol.dispose]: () => Reflect.deleteProperty(Range.prototype, "getBoundingClientRect"),
    };
    container.querySelector<HTMLElement>("[data-thread-find-fold]")!.getBoundingClientRect = () =>
      new DOMRect(0, 0, 800, 100);
    const props = {
      container,
      query: "COD4",
      activeRowId: "first",
      activeOccurrence: 0,
      onActiveRange,
    };
    await using screen = await render(<Probe {...props} />);
    const inactive = CSS.highlights.get("t3-thread-find");
    const first = activeRanges()[0];
    bounds.mockClear();
    await screen.rerender(<Probe {...props} activeOccurrence={1} />);
    expect(bounds).toHaveBeenCalledTimes(2);
    expect(CSS.highlights.get("t3-thread-find")).toBe(inactive);
    expect(inactive?.size).toBe(1499);
    expect(inactive?.has(first!)).toBe(true);
    expect(activeRanges()[0]?.startOffset).toBe(5);
    expect(inactive?.has(activeRanges()[0]!)).toBe(false);
  });

  it("repaints for searchable text changes but not for timers outside it", async () => {
    using find = setup();
    const { container, onActiveRange } = find;
    const timer = document.createElement("span");
    container.firstElementChild!.append(timer);
    await using _screen = await render(
      <Probe
        container={container}
        query="COD4"
        activeRowId="first"
        activeOccurrence={0}
        onActiveRange={onActiveRange}
      />,
    );
    onActiveRange.mockClear();
    await act(async () => {
      timer.textContent = "0:01";
      await nextFrame();
    });
    expect(onActiveRange).not.toHaveBeenCalled();
    await act(async () => {
      container.querySelector("p")!.append(" COD4");
      await nextFrame();
    });
    expect(onActiveRange).toHaveBeenCalled();
  });

  it("opens only the selected fold while reusing its cached text", async () => {
    using find = setup();
    const { container, onActiveRange } = find;
    container.innerHTML =
      '<div data-timeline-row-id="first"><div hidden><p data-thread-find-text>COD4 COD4</p></div></div>' +
      '<div data-timeline-row-id="second"><div hidden><p data-thread-find-text>COD4</p></div></div>';
    const folds = [...container.querySelectorAll<HTMLElement>("[hidden]")];
    for (const fold of folds)
      fold.addEventListener("beforematch", () => fold.removeAttribute("hidden"));
    using createRange = vi.spyOn(document, "createRange");
    await using screen = await render(
      <Probe
        container={container}
        query="COD4"
        activeRowId="first"
        activeOccurrence={0}
        onActiveRange={onActiveRange}
      />,
    );
    await act(nextFrame);
    expect(folds[0]?.hasAttribute("hidden")).toBe(false);
    expect(folds[1]?.hasAttribute("hidden")).toBe(true);
    expect(activeRanges()[0]?.toString()).toBe("COD4");
    expect(CSS.highlights.get("t3-thread-find")?.size).toBe(1);
    const scanned = createRange.mock.calls.length;
    await screen.rerender(
      <Probe
        container={container}
        query="COD4"
        activeRowId="first"
        activeOccurrence={1}
        onActiveRange={onActiveRange}
      />,
    );
    expect(createRange).toHaveBeenCalledTimes(scanned);
    expect(activeRanges()[0]?.startOffset).toBe(5);
  });

  it("observes rows mounted synchronously while revealing the first match", async () => {
    using find = setup();
    const { container, onActiveRange } = find;
    container.replaceChildren();
    onActiveRange.mockImplementationOnce(() => {
      container.innerHTML =
        '<div data-timeline-row-id="first"><p data-thread-find-text>COD4</p></div>';
    });
    await using _screen = await render(
      <Probe
        container={container}
        query="COD4"
        activeRowId="first"
        activeOccurrence={0}
        onActiveRange={onActiveRange}
      />,
    );
    await act(nextFrame);
    expect(activeRanges()[0]?.toString()).toBe("COD4");
  });

  it("rebuilds ranges when the list moves or recycles an existing row", async () => {
    using find = setup();
    const { container, onActiveRange } = find;
    const props = {
      container,
      query: "COD4",
      activeRowId: "first",
      activeOccurrence: 0,
      onActiveRange,
    };
    await using screen = await render(<Probe {...props} />);
    const initial = activeRanges()[0];
    const row = container.querySelector<HTMLElement>('[data-timeline-row-id="first"]')!;
    await act(async () => {
      row.remove();
      container.append(row);
      await nextFrame();
    });
    expect(activeRanges()[0]).not.toBe(initial);
    expect(activeRanges()[0]?.toString()).toBe("COD4");
    await act(async () => {
      row.dataset.timelineRowId = "recycled";
      await nextFrame();
    });
    expect(activeRanges()).toHaveLength(0);
    await screen.rerender(<Probe {...props} activeRowId="recycled" />);
    expect(activeRanges()[0]?.toString()).toBe("COD4");
  });

  it("reuses unchanged text ranges on navigation and scans only the streaming row", async () => {
    using find = setup();
    const { container, onActiveRange } = find;
    using createRange = vi.spyOn(document, "createRange");
    const props = {
      container,
      query: "COD4",
      activeRowId: "first",
      activeOccurrence: 0,
      onActiveRange,
    };
    await using screen = await render(<Probe {...props} />);
    expect(createRange).toHaveBeenCalledTimes(3);
    const initial = activeRanges()[0];
    await screen.rerender(<Probe {...props} activeOccurrence={1} />);
    expect(createRange).toHaveBeenCalledTimes(3);
    expect(activeRanges()[0]?.startOffset).toBe(9);
    await screen.rerender(<Probe {...props} />);
    expect(activeRanges()[0]).toBe(initial);
    await act(async () => {
      container.querySelector('[data-timeline-row-id="second"] p')!.firstChild!.nodeValue =
        "COD4 COD4";
      await nextFrame();
    });
    expect(createRange).toHaveBeenCalledTimes(5);
    expect(activeRanges()[0]).toBe(initial);
    await screen.rerender(<Probe {...props} activeRowId="second" activeOccurrence={1} />);
    expect(createRange).toHaveBeenCalledTimes(5);
    expect(activeRanges()[0]?.toString()).toBe("COD4");
    expect(activeRanges()[0]?.startOffset).toBe(5);
    await act(async () => {
      container.querySelector('[data-timeline-row-id="second"]')!.remove();
      await nextFrame();
    });
    expect(activeRanges()).toHaveLength(0);
    expect(onActiveRange).toHaveBeenLastCalledWith(null);
    expect(CSS.highlights.get("t3-thread-find")?.size).toBe(2);
    await screen.rerender(<Probe {...props} query="missing" />);
    expect(CSS.highlights.get("t3-thread-find")?.size).toBe(0);
  });
});

function row(html: string) {
  const container = document.createElement("div");
  container.innerHTML = `<div data-timeline-row-id="row"><div data-thread-find-text>${html}</div></div>`;
  return container;
}

describe("collectThreadFindRanges", () => {
  it("finds matches split across inline token spans, in order", () => {
    // Shiki-style tokens split one identifier over several text nodes.
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

  it("finds every match across thousands of token nodes", () => {
    const tokens = Array.from({ length: 4000 }, (_, i) => `<span>id</span><span>${i} </span>`);
    const container = row(`<pre><code>${tokens.join("")}</code></pre>`);
    const ranges = collectThreadFindRanges(container, "id");
    expect(ranges).toHaveLength(4000);
    expect(ranges.map((match) => match.occurrence)).toEqual([...ranges.keys()]);
    expect(ranges.every((match) => match.range.toString() === "id")).toBe(true);
  });
});
