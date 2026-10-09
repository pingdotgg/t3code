// @vitest-environment jsdom

import type { LegendListRef } from "@legendapp/list/react";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useThreadFindNavigation } from "./useThreadFindNavigation";

const renders = vi.fn();
function Probe(props: Parameters<typeof useThreadFindNavigation>[0]) {
  renders();
  useThreadFindNavigation(props);
  return null;
}

let root: Root;
let host: HTMLDivElement;
let container: HTMLDivElement;
let rect: DOMRect;
const scrollToIndex = vi.fn<LegendListRef["scrollToIndex"]>();
const scrollToOffset = vi.fn<LegendListRef["scrollToOffset"]>();
let props: ComponentProps<typeof Probe>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CSS", { highlights: new Map() });
  vi.stubGlobal(
    "Highlight",
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges);
      }
    },
  );
  rect = new DOMRect(0, 200, 40, 20);
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => rect,
  });
  host = document.createElement("div");
  container = document.createElement("div");
  container.innerHTML =
    '<div data-timeline-row-id="message"><p data-thread-find-text>COD4 and COD4</p></div>';
  container.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  document.body.append(host, container);
  root = createRoot(host);
  scrollToIndex.mockResolvedValue();
  props = {
    container,
    query: "COD4",
    match: { entryId: "message", runId: null, occurrence: 0 },
    navigationId: 0,
    rowIndex: 0,
    entries: [{ id: "message" }],
    listRef: {
      current: {
        scrollToIndex,
        scrollToOffset,
        getState: () => ({ scroll: 300 }),
      } as unknown as LegendListRef,
    },
    contentInsetEndAdjustment: 100,
    listReady: true,
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  container.remove();
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("find result navigation", () => {
  it("retargets a pending first jump when progressive history moves the matching row", async () => {
    container.replaceChildren();
    let first!: () => void;
    let second!: () => void;
    scrollToIndex
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            first = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            second = resolve;
          }),
      );
    await act(async () => root.render(<Probe {...props} rowIndex={2} />));
    await act(async () =>
      root.render(<Probe {...props} rowIndex={6} entries={[{ id: "tool" }, ...props.entries]} />),
    );
    expect(scrollToIndex.mock.calls.map(([request]) => request.index)).toEqual([2, 6]);
    await act(async () => first());
    expect(scrollToOffset).not.toHaveBeenCalled();
    await act(async () => {
      container.innerHTML =
        '<div data-timeline-row-id="message"><p data-thread-find-text>COD4</p></div>';
      rect = new DOMRect(0, 450, 40, 20);
      second();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 366, animated: false });
  });

  it("keeps the highlighted text at the same position when progressive activity arrives", async () => {
    const historyControls = {
      hasMoreHistory: true,
      loading: true,
      error: null,
      onLoadEarlier: vi.fn(),
    };
    await act(async () => root.render(<Probe {...props} historyControls={historyControls} />));
    rect = new DOMRect(0, 368, 40, 20);
    scrollToOffset.mockImplementationOnce(async () => {
      rect = new DOMRect(0, 200, 40, 20);
    });
    await act(async () =>
      root.render(
        <Probe
          {...props}
          entries={[{ id: "tool" }, { id: "message" }]}
          historyControls={{ ...historyControls, loading: false }}
        />,
      ),
    );
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 468, animated: false });
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("respects scrolling away from a partial match before activity arrives", async () => {
    const historyControls = {
      hasMoreHistory: true,
      loading: true,
      error: null,
      onLoadEarlier: vi.fn(),
    };
    await act(async () => root.render(<Probe {...props} historyControls={historyControls} />));
    rect = new DOMRect(0, -600, 40, 20);
    container.dispatchEvent(new Event("scroll"));
    await act(async () =>
      root.render(
        <Probe
          {...props}
          entries={[{ id: "tool" }, { id: "message" }]}
          historyControls={{ ...historyControls, loading: false }}
        />,
      ),
    );
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  it("reveals settled virtual text without another timeline render", async () => {
    let complete!: () => void;
    scrollToIndex.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    rect = new DOMRect(0, 1800, 40, 20);
    await act(async () => root.render(<Probe {...props} />));
    expect(renders).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).not.toHaveBeenCalled();
    rect = new DOMRect(0, 450, 40, 20);
    await act(async () => {
      complete();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 366, animated: false });
    expect(renders).toHaveBeenCalledTimes(1);
  });

  it("ignores an older scroll completion after navigation moves to another occurrence", async () => {
    let first!: () => void;
    let second!: () => void;
    scrollToIndex
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            first = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            second = resolve;
          }),
      );
    rect = new DOMRect(0, 1800, 40, 20);
    await act(async () => root.render(<Probe {...props} />));
    await act(async () =>
      root.render(
        <Probe
          {...props}
          navigationId={1}
          match={{ entryId: "message", runId: null, occurrence: 1 }}
        />,
      ),
    );
    rect = new DOMRect(0, 450, 40, 20);
    await act(async () => first());
    expect(scrollToOffset).not.toHaveBeenCalled();
    await act(async () => {
      second();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 366, animated: false });
  });

  it("loads history until a distant match can be revealed in the conversation", async () => {
    const onLoadEarlier = vi.fn();
    const historyControls = { hasMoreHistory: true, loading: false, error: null, onLoadEarlier };
    const pending = { ...props, rowIndex: -1, entries: [{ id: "recent" }], historyControls };
    await act(async () => root.render(<Probe {...pending} />));
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).not.toHaveBeenCalled();
    await act(async () =>
      root.render(<Probe {...pending} historyControls={{ ...historyControls, loading: true }} />),
    );
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    await act(async () =>
      root.render(<Probe {...pending} entries={[{ id: "older" }, ...pending.entries]} />),
    );
    expect(onLoadEarlier).toHaveBeenCalledTimes(2);
    rect = new DOMRect(0, 1800, 40, 20);
    scrollToIndex.mockImplementationOnce(async () => {
      rect = new DOMRect(0, 200, 40, 20);
    });
    await act(async () => root.render(<Probe {...props} historyControls={historyControls} />));
    expect(onLoadEarlier).toHaveBeenCalledTimes(2);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it("waits for list bootstrap before positioning the first result", async () => {
    rect = new DOMRect(0, 1800, 40, 20);
    await act(async () => root.render(<Probe {...props} listReady={false} />));
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(scrollToOffset).not.toHaveBeenCalled();
    scrollToIndex.mockImplementationOnce(async () => {
      rect = new DOMRect(0, 200, 40, 20);
    });
    await act(async () => root.render(<Probe {...props} />));
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).not.toHaveBeenCalled();
  });
  it("leaves the scroll position unchanged between already visible occurrences", async () => {
    await act(async () => root.render(<Probe {...props} />));
    await act(async () =>
      root.render(
        <Probe
          {...props}
          navigationId={1}
          match={{ entryId: "message", runId: null, occurrence: 1 }}
        />,
      ),
    );
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(scrollToOffset).not.toHaveBeenCalled();
    const highlight = CSS.highlights.get("t3-thread-find-active");
    const ranges = [...(highlight as unknown as Set<Range>)];
    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.startOffset).toBe(9);
    expect(ranges[0]?.toString()).toBe("COD4");
  });

  it("reveals the same match again when search restarts after scrolling away", async () => {
    await act(async () => root.render(<Probe {...props} />));
    rect = new DOMRect(0, -1800, 40, 20);
    props.listRef.current = {
      scrollToIndex,
      scrollToOffset,
      getState: () => ({ scroll: 2400 }),
    } as unknown as LegendListRef;
    await act(async () => root.render(<Probe {...props} navigationId={1} />));
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 504, animated: false });
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(
      Array.from(CSS.highlights.get("t3-thread-find-active") ?? [], (range) => range.toString()),
    ).toEqual(["COD4"]);
  });

  it("moves only far enough to reveal text below the composer", async () => {
    await act(async () => root.render(<Probe {...props} />));
    rect = new DOMRect(0, 450, 40, 20);
    await act(async () =>
      root.render(
        <Probe
          {...props}
          navigationId={1}
          match={{ entryId: "message", runId: null, occurrence: 1 }}
        />,
      ),
    );
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 366, animated: false });
  });

  it("moves only far enough to reveal text above the viewport margin", async () => {
    await act(async () => root.render(<Probe {...props} />));
    rect = new DOMRect(0, 40, 40, 20);
    await act(async () =>
      root.render(
        <Probe
          {...props}
          navigationId={1}
          match={{ entryId: "message", runId: null, occurrence: 1 }}
        />,
      ),
    );
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 244, animated: false });
  });

  it("keeps the selected text visible when newly measured rows shift during scrolling", async () => {
    let scroll = 300;
    props.listRef.current = {
      scrollToIndex,
      scrollToOffset,
      getState: () => ({ scroll }),
    } as unknown as LegendListRef;
    scrollToOffset
      .mockImplementationOnce(async ({ offset }) => {
        scroll = offset;
        // Newly mounted row measurements offset the first scroll movement.
      })
      .mockImplementationOnce(async ({ offset }) => {
        scroll = offset;
        rect = new DOMRect(0, 200, 40, 20);
      });
    await act(async () => root.render(<Probe {...props} />));
    rect = new DOMRect(0, 450, 40, 20);
    await act(async () =>
      root.render(
        <Probe
          {...props}
          navigationId={1}
          match={{ entryId: "message", runId: null, occurrence: 1 }}
        />,
      ),
    );
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    expect(rect.top).toBe(200);
    expect(scrollToOffset.mock.calls).toEqual([
      [{ offset: 366, animated: false }],
      [{ offset: 432, animated: false }],
    ]);
    expect(renders).toHaveBeenCalledTimes(2);
  });

  it("waits for a new context window to settle before revealing an offscreen result", async () => {
    rect = new DOMRect(0, 1800, 40, 20);
    scrollToIndex.mockImplementationOnce(async () => {
      rect = new DOMRect(0, 450, 40, 20);
    });
    await act(async () => {
      root.render(<Probe {...props} />);
    });
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 366, animated: false });
  });

  it("materializes a virtualized message before revealing its occurrence", async () => {
    container.replaceChildren();
    await act(async () => root.render(<Probe {...props} rowIndex={4} />));
    expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith({
      index: 4,
      animated: false,
      viewOffset: 96,
    });
    expect(scrollToOffset).not.toHaveBeenCalled();
    rect = new DOMRect(0, 450, 40, 20);
    await act(async () => {
      container.innerHTML =
        '<div data-timeline-row-id="message"><p data-thread-find-text>COD4</p></div>';
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).toHaveBeenCalledExactlyOnceWith({ offset: 366, animated: false });
  });
});
