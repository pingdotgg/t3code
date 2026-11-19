import type { LegendListRef } from "@legendapp/list/react";
import { EnvironmentId, MessageId } from "@t3tools/contracts";
import { createRef, useSyncExternalStore, type ComponentProps, type ReactElement } from "react";
import { flushSync } from "react-dom";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../test/render";
import { MessagesTimeline } from "../components/chat/MessagesTimeline";
import { forwardWheelToTimeline } from "../components/chat/timelineMinimapWheel";
import { readTimelinePosition } from "../components/chat/timelineScrollAnchoring";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

const CREATED_AT = "2026-03-17T19:12:28.000Z";
const WIDE = "900px";
const NARROW = "520px";
const WHEEL_PX = 300;
const GLIDE_LINES = 20;
// The product's probe points.
const PROBE = { laneFractions: [0.15, 0.3, 0.5], top: 30, bottom: 300, step: 6 };

function message(
  id: string,
  text: string,
  role: "user" | "assistant" = "assistant",
  streaming = false,
): Entry {
  return {
    id,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role,
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming,
    },
  };
}

const tool = (id: string): Entry => ({
  id,
  kind: "work",
  createdAt: CREATED_AT,
  entry: { id, createdAt: CREATED_AT, label: `Ran ${id}`, tone: "tool" },
});

const words = (tag: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${tag}w${index}`).join(" ");

const history = (count: number, length: (index: number) => number) =>
  Array.from({ length: count }, (_, index) =>
    message(`m${index}`, words(`m${index}`, length(index))),
  );

function props(listRef: TimelineProps["listRef"]): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    listRef,
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:reader-line-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: false,
    onIsAtEndChange: () => {},
  };
}

function liveText(initial: string) {
  let text = initial;
  const listeners = new Set<() => void>();
  return {
    read: () => text,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    append: (more: string) => {
      text += more;
      for (const listener of listeners) listener();
    },
  };
}

function LiveTimeline({
  live,
  earlier,
  ...rest
}: Omit<TimelineProps, "timelineEntries"> & {
  readonly live: ReturnType<typeof liveText>;
  readonly earlier: ReadonlyArray<Entry>;
}) {
  const text = useSyncExternalStore(live.subscribe, live.read);
  return (
    <MessagesTimeline
      {...rest}
      timelineEntries={[...earlier, message("live", text, "assistant", true)]}
    />
  );
}

async function renderTimeline(
  width: string,
  timeline: (listRef: TimelineProps["listRef"]) => ReactElement,
  height = "600px",
) {
  const listRef = createRef<LegendListRef | null>();
  const container = document.createElement("div");
  container.style.cssText = `height: ${height}; width: ${width}; display: flex; flex-direction: column;`;
  const screen = await render(timeline(listRef), { container });
  return Object.assign(screen, {
    list: () => listRef.current!,
    scroller: () => listRef.current!.getScrollableNode() as HTMLElement,
  });
}

// Settled once four reads 50 ms apart agree: the timeline treats a scroll under 100 ms old as
// still moving, and holds no line then. A read that scrolls must return something that differs.
async function settle(read: () => string) {
  let previous: string | undefined;
  let agreeing = 0;
  await vi.waitFor(
    () => {
      const next = read();
      agreeing = next === previous ? agreeing + 1 : 0;
      previous = next;
      if (agreeing < 3) throw new Error(`still moving: ${next}`);
    },
    { timeout: 5_000 },
  );
}

// Runs in the next frame's resize observations, after that frame's animation callbacks.
function inNextObservations(callback: () => void) {
  const target = document.createElement("div");
  target.style.cssText = "position: fixed; width: 1px; height: 1px; pointer-events: none;";
  document.body.append(target);
  const observer = new ResizeObserver(() => {
    observer.disconnect();
    target.remove();
    callback();
  });
  observer.observe(target);
}

// No product state shows the timeline sampled the last scroll; it does so before the next observations.
const nextRenderingUpdate = () => new Promise<void>((resolve) => inNextObservations(resolve));

function mouse(type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number) {
  const frame = window.frameElement?.getBoundingClientRect();
  return cdp().send("Input.dispatchMouseEvent", {
    type,
    x: x + (frame?.left ?? 0),
    y: y + (frame?.top ?? 0),
    button: "left",
    buttons: type === "mouseReleased" ? 0 : 1,
    clickCount: 1,
  });
}

const rowTop = (scroller: HTMLElement, rowId: string) =>
  scroller.querySelector(`[data-timeline-row-id="${rowId}"]`)!.getBoundingClientRect().top -
  scroller.getBoundingClientRect().top;

async function scrollRowTo(
  screen: Awaited<ReturnType<typeof renderTimeline>>,
  rowId: string,
  top: number,
) {
  await vi.waitFor(() => expect(screen.list().getState().indexByKey(rowId)).toBeDefined());
  const scroller = screen.scroller();
  await settle(() => {
    const row = scroller.querySelector(`[data-timeline-row-id="${rowId}"]`);
    if (!row) {
      const state = screen.list().getState();
      scroller.scrollTop = state.positionAtIndex(state.indexByKey(rowId)!) ?? 0;
      throw new Error(`${rowId} is not mounted`);
    }
    const delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - top;
    const moves = Math.abs(delta) > 0.5;
    if (moves) scroller.scrollTop += delta;
    return `${moves}|${scroller.scrollTop}|${scroller.scrollHeight}`;
  });
  await nextRenderingUpdate();
}

// Rests the list `px` above its end, against LegendList's own scrolls to the end.
async function restFromEnd(scroller: HTMLElement, px: number) {
  await settle(() => {
    const away = distanceFromEnd(scroller) - px;
    const moves = Math.abs(away) > 0.5;
    if (moves) scroller.scrollTop += away;
    return `${moves}|${scroller.scrollTop}|${scroller.scrollHeight}`;
  });
  await nextRenderingUpdate();
}

// The first character fully in view at the product's probe points, which a paragraph gap can skip.
function readerMark(scroller: HTMLElement) {
  const lane = scroller.querySelector("[data-timeline-root]")!.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  for (let dy = PROBE.top; dy <= PROBE.bottom; dy += PROBE.step) {
    const y = view.top + dy;
    for (const fraction of PROBE.laneFractions) {
      const caret = document.caretPositionFromPoint(lane.left + lane.width * fraction, y);
      const node = caret?.offsetNode;
      const row = node?.parentElement?.closest<HTMLElement>("[data-timeline-row-id]");
      if (!caret || !(node instanceof Text) || !row) continue;
      const offset = [caret.offset, caret.offset - 1].find((at) => node.data[at]?.trim());
      if (offset === undefined) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const box = range.getBoundingClientRect();
      if (box.top > y || box.bottom < y || box.top < view.top || box.bottom > view.bottom) continue;
      return {
        row,
        label: node.data.slice(Math.max(0, offset - 10), offset + 1),
        top: () => range.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
      };
    }
  }
  throw new Error("no timeline text at the probe points");
}

async function expectLineHeld(
  screen: Awaited<ReturnType<typeof renderTimeline>>,
  change: () => unknown,
) {
  const scroller = screen.scroller();
  const mark = readerMark(scroller);
  const before = mark.top();
  const widthBefore = mark.row.getBoundingClientRect().width;
  const observed: number[] = [];
  const sample = () => void observed.push(mark.top());
  // Made after the product's observer, so in each pass it reads what that observer left.
  const observer = new ResizeObserver(sample);
  observer.observe(mark.row);
  // Read at the end of each scrolled frame: a scroll event comes before that frame's corrections
  // and after any task between frames, so it can see a state that is never painted.
  const sampleFrame = () => inNextObservations(sample);
  scroller.addEventListener("scroll", sampleFrame, { passive: true });
  try {
    await change();
    await vi.waitFor(() => expect(mark.row.getBoundingClientRect().width).not.toBe(widthBefore));
    await settle(() => `${scroller.scrollTop}|${scroller.scrollHeight}|${mark.top()}`);
    const drift = (top: number) => Math.round((top - before) * 10) / 10;
    expect(drift(mark.top()), `final drift of "${mark.label}"`).toSatisfy(
      (value: number) => Math.abs(value) <= 1,
    );
    expect(
      observed.map(drift).filter((value) => Math.abs(value) > 1),
      `observed drift of "${mark.label}"`,
    ).toEqual([]);
  } finally {
    observer.disconnect();
    scroller.removeEventListener("scroll", sampleFrame);
  }
}

const distanceFromEnd = (scroller: HTMLElement) =>
  scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;

const rows = history(30, (index) => 150 + (index % 3) * 30);

describe("timeline reader line", () => {
  it("keeps a partly visible top row's line in place when the chat narrows", async () => {
    await using screen = await renderTimeline(WIDE, (listRef) => (
      <MessagesTimeline {...props(listRef)} timelineEntries={rows} />
    ));
    await scrollRowTo(screen, "m16", 120);
    await expectLineHeld(screen, () => {
      screen.container.style.width = NARROW;
    });
  });

  it("keeps a partly visible top row's line in place when the chat widens", async () => {
    await using screen = await renderTimeline(NARROW, (listRef) => (
      <MessagesTimeline {...props(listRef)} timelineEntries={rows} />
    ));
    await scrollRowTo(screen, "m16", 120);
    await expectLineHeld(screen, () => {
      screen.container.style.width = WIDE;
    });
  });

  it("keeps the line inside a single tall row in place when the chat narrows", async () => {
    await using screen = await renderTimeline(WIDE, (listRef) => (
      <MessagesTimeline
        {...props(listRef)}
        timelineEntries={[message("tall", words("tall", 3000))]}
      />
    ));
    await scrollRowTo(screen, "tall", -2000);
    await expectLineHeld(screen, () => {
      screen.container.style.width = NARROW;
    });
  });

  it("keeps the line in place when the chat narrows after a selection dragged to the top edge", async () => {
    await using screen = await renderTimeline(WIDE, (listRef) => (
      <MessagesTimeline {...props(listRef)} timelineEntries={history(30, () => 400)} />
    ));
    const scroller = screen.scroller();
    await scrollRowTo(screen, "m15", -300);
    await using stack = new AsyncDisposableStack();
    stack.defer(async () => {
      await mouse("mouseReleased", 0, 0);
      document.getSelection()?.removeAllRanges();
    });
    const view = scroller.getBoundingClientRect();
    const lane = scroller.querySelector("[data-timeline-root]")!.getBoundingClientRect();
    const start = scroller.scrollTop;
    await mouse("mousePressed", lane.left + 40, view.top + 120);
    // Chromium autoscrolls while the pointer is just inside the top edge.
    await mouse("mouseMoved", lane.left + 100, view.top + 5);
    await vi.waitFor(() => expect(scroller.scrollTop).toBeLessThan(start - 120), {
      timeout: 10_000,
    });
    await mouse("mouseReleased", lane.left + 100, view.top + 5);
    expect(document.getSelection()?.isCollapsed).toBe(false);
    await settle(() => `${scroller.scrollTop}|${scroller.scrollHeight}`);
    await nextRenderingUpdate();
    await expectLineHeld(screen, () => {
      screen.container.style.width = NARROW;
    });
  });

  it("lets a selection dragged to the bottom edge scroll the chat while it narrows", async () => {
    // Rows this short never rewrap, so only the selection autoscroll moves the chat.
    await using screen = await renderTimeline("700px", (listRef) => (
      <MessagesTimeline {...props(listRef)} timelineEntries={history(80, () => 3)} />
    ));
    const scroller = screen.scroller();
    await scrollRowTo(screen, "m30", 0);
    await using stack = new AsyncDisposableStack();
    stack.defer(async () => {
      await mouse("mouseReleased", 0, 0);
      document.getSelection()?.removeAllRanges();
    });
    const view = scroller.getBoundingClientRect();
    const lane = scroller.querySelector("[data-timeline-root]")!;
    const { left, width } = lane.getBoundingClientRect();
    await mouse("mousePressed", left + 20, view.top + 120);
    await mouse("mouseMoved", left + 60, view.top + 300);
    expect(document.getSelection()?.isCollapsed).toBe(false);
    // A width that changes on every frame keeps any hold running through the drag.
    screen.container.style.transition = "width 3s linear";
    screen.container.style.width = "500px";
    await vi.waitFor(() => expect(lane.getBoundingClientRect().width).toBeLessThan(width - 2));
    const start = scroller.scrollTop;
    const moves: number[] = [];
    const record = () => void moves.push(scroller.scrollTop - start);
    scroller.addEventListener("scroll", record, { passive: true });
    stack.defer(() => scroller.removeEventListener("scroll", record));
    await mouse("mouseMoved", left + 60, view.bottom - 4);
    // A slow runner's steps can be large enough to reach the end within a few.
    const settledSteps = () => moves.length >= 10 || distanceFromEnd(scroller) <= 1;
    await vi.waitFor(() => expect(settledSteps()).toBe(true), { timeout: 10_000 });
    const last = moves.slice(0, 10).at(-1);
    expect(moves[0], "the first autoscroll step").toBeGreaterThan(0);
    expect(
      last,
      `the scroll after ${Math.min(moves.length, 10)} steps, the first ${moves[0]} px`,
    ).toBeGreaterThan(3 * moves[0]!);
  });

  it("lets a wheel scroll stand when the chat narrows in the same turn", async () => {
    await using screen = await renderTimeline(WIDE, (listRef) => (
      <MessagesTimeline {...props(listRef)} timelineEntries={rows} />
    ));
    const scroller = screen.scroller();
    await scrollRowTo(screen, "m16", 120);
    const narrow = () => {
      screen.container.style.width = NARROW;
    };
    scroller.addEventListener("wheel", narrow, { once: true, passive: true });
    const view = scroller.getBoundingClientRect();
    const lane = scroller.querySelector("[data-timeline-root]")!.getBoundingClientRect();
    const frame = window.frameElement?.getBoundingClientRect();
    await cdp().send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: lane.left + 40 + (frame?.left ?? 0),
      y: view.top + 200 + (frame?.top ?? 0),
      deltaX: 0,
      deltaY: WHEEL_PX,
    });
    await vi.waitFor(() => expect(screen.container.style.width).toBe(NARROW));
    await settle(() => `${scroller.scrollTop}|${scroller.scrollHeight}|${rowTop(scroller, "m16")}`);
    expect(
      rowTop(scroller, "m16"),
      `m16's top after a ${WHEEL_PX} px wheel down from 120`,
    ).toBeLessThan(120 - WHEEL_PX / 2);
  });

  it("lets a minimap wheel glide reach its target when the chat narrows during it", async () => {
    await using screen = await renderTimeline(WIDE, (listRef) => (
      <MessagesTimeline {...props(listRef)} timelineEntries={rows} />
    ));
    const scroller = screen.scroller();
    await scrollRowTo(screen, "m16", 120);
    const glidePx = GLIDE_LINES * 16;
    // The first scroll event follows the glide's first step; the width then changes after the
    // next frame's step.
    const narrowMidGlide = () =>
      inNextObservations(() => {
        screen.container.style.width = NARROW;
      });
    scroller.addEventListener("scroll", narrowMidGlide, { once: true, passive: true });
    forwardWheelToTimeline(
      new WheelEvent("wheel", {
        cancelable: true,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaY: GLIDE_LINES,
      }),
      scroller,
    );
    await vi.waitFor(() => expect(screen.container.style.width).toBe(NARROW));
    await settle(() => `${scroller.scrollTop}|${scroller.scrollHeight}|${rowTop(scroller, "m16")}`);
    expect(
      rowTop(scroller, "m16"),
      `m16's top after a ${glidePx} px glide down from 120`,
    ).toBeLessThan(120 - glidePx * 0.9);
  });

  it("keeps the line in place when a press inside the chat narrows it in the same turn", async () => {
    await using screen = await renderTimeline(WIDE, (listRef) => (
      <MessagesTimeline {...props(listRef)} timelineEntries={rows} />
    ));
    const scroller = screen.scroller();
    await scrollRowTo(screen, "m16", 120);
    const view = scroller.getBoundingClientRect();
    const lane = scroller.querySelector("[data-timeline-root]")!.getBoundingClientRect();
    const press = { x: lane.left + 40, y: view.top + 200 };
    await using stack = new AsyncDisposableStack();
    stack.defer(async () => {
      await mouse("mouseReleased", press.x, press.y);
    });
    // As a press on an attachment opens the side panel.
    const openPanel = () => {
      screen.container.style.width = NARROW;
    };
    scroller.addEventListener("pointerdown", openPanel, { once: true, passive: true });
    await expectLineHeld(screen, () => mouse("mousePressed", press.x, press.y));
  });

  it("keeps the line in place when the chat narrows after find closes with no scroll", async () => {
    let base: Omit<TimelineProps, "timelineEntries"> | undefined;
    await using screen = await renderTimeline(WIDE, (listRef) => {
      base = props(listRef);
      return <MessagesTimeline {...base} timelineEntries={rows} findOpen findExpanded />;
    });
    await scrollRowTo(screen, "m16", 120);
    await screen.rerender(<MessagesTimeline {...base!} timelineEntries={rows} />);
    await nextRenderingUpdate();
    await expectLineHeld(screen, () => {
      screen.container.style.width = NARROW;
    });
  });

  it("keeps the line in place when the chat narrows after a work group opened", async () => {
    await using screen = await renderTimeline(WIDE, (listRef) => (
      <MessagesTimeline
        {...props(listRef)}
        timelineEntries={[...rows.slice(0, 16), tool("t0"), tool("t1"), ...rows.slice(16)]}
      />
    ));
    const scroller = screen.scroller();
    // High enough that the opened group stays in view once the layout settles.
    await scrollRowTo(screen, "work-toggle:t0", 120);
    scroller.querySelector<HTMLElement>('[data-timeline-row-kind="work-toggle"] button')!.click();
    await vi.waitFor(() =>
      expect(scroller.querySelector('[data-timeline-row-id$=":details"]')).not.toBeNull(),
    );
    await settle(() => `${scroller.scrollTop}|${scroller.scrollHeight}`);
    await nextRenderingUpdate();
    await expectLineHeld(screen, () => {
      screen.container.style.width = NARROW;
    });
  });

  it("keeps the line in place when the chat narrows as text streams into its row", async () => {
    const live = liveText(words("live", 2500));
    await using screen = await renderTimeline(WIDE, (listRef) => (
      <LiveTimeline {...props(listRef)} live={live} earlier={history(3, () => 150)} />
    ));
    await scrollRowTo(screen, "live", -1500);
    await expectLineHeld(screen, () => {
      flushSync(() => live.append(`\n\n${words("more", 80)}`));
      screen.container.style.width = NARROW;
    });
  });

  it("keeps the line in place and follow released when a widen rewraps only text below it into the end band", async () => {
    const reports: boolean[] = [];
    await using screen = await renderTimeline(WIDE, (listRef) => (
      <MessagesTimeline
        {...props(listRef)}
        timelineEntries={[...history(20, () => 3), message("tail", words("tail", 160))]}
        onIsAtEndChange={(atEnd) => reports.push(atEnd)}
      />
    ));
    const scroller = screen.scroller();
    const tailHeight = () =>
      scroller.querySelector('[data-timeline-row-id="tail"]')!.getBoundingClientRect().height;
    await vi.waitFor(() => expect(distanceFromEnd(scroller)).toBeLessThanOrEqual(1));
    const wideTail = tailHeight();
    screen.container.style.width = NARROW;
    await vi.waitFor(() => expect(tailHeight()).toBeGreaterThan(wideTail));
    const narrowTail = tailHeight();
    // The widen will leave the list 20 px from its end.
    await restFromEnd(scroller, narrowTail - wideTail + 20);
    expect(distanceFromEnd(scroller), "distance from the end before the widen").toBeGreaterThan(44);
    const view = scroller.getBoundingClientRect();
    const line = [...scroller.querySelectorAll<HTMLElement>("[data-timeline-row-id]")].find(
      (row) => row.getBoundingClientRect().top >= view.top,
    )!.dataset.timelineRowId!;
    const before = rowTop(scroller, line);
    reports.length = 0;
    screen.container.style.width = WIDE;
    await vi.waitFor(() => expect(tailHeight()).toBeLessThan(narrowTail));
    await settle(() => `${scroller.scrollTop}|${scroller.scrollHeight}|${rowTop(scroller, line)}`);
    expect(rowTop(scroller, line) - before, `${line}'s move`).toSatisfy(
      (value: number) => Math.abs(value) <= 1,
    );
    expect(distanceFromEnd(scroller), "distance from the end after the widen").toBeLessThan(40);
    expect(reports).not.toContain(true);
  });

  it("keeps follow released and the saved place off the end, through a later size change, when a widen leaves under 40 px to scroll", async () => {
    const thread = `environment-local:reader-line-short-${Math.random().toString(36).slice(2)}`;
    const reports: boolean[] = [];
    const entries = (tail: string) => [message("s0", `${words("s0", 320)}${tail}`)];
    let base: Omit<TimelineProps, "timelineEntries"> | undefined;
    await using screen = await renderTimeline(
      WIDE,
      (listRef) => {
        base = {
          ...props(listRef),
          routeThreadKey: thread,
          onIsAtEndChange: (atEnd) => reports.push(atEnd),
        };
        return <MessagesTimeline {...base} timelineEntries={entries("")} />;
      },
      "200px",
    );
    const scroller = screen.scroller();
    const range = () => scroller.scrollHeight - scroller.clientHeight;
    await settle(() => `${scroller.scrollHeight}`);
    // The widen will leave 6 px to scroll, and the line added later stays inside the end band.
    screen.container.style.height = `${scroller.scrollHeight - 6}px`;
    screen.container.style.width = NARROW;
    await vi.waitFor(() => expect(range()).toBeGreaterThan(110));
    await restFromEnd(scroller, 70);

    expect(range(), "scroll range before the widen").toBeGreaterThan(110);
    const height = scroller.scrollHeight;
    reports.length = 0;
    screen.container.style.width = WIDE;
    await vi.waitFor(() => expect(scroller.scrollHeight).toBeLessThan(height));
    await settle(() => `${scroller.scrollTop}|${scroller.scrollHeight}`);
    expect(range(), "scroll range after the widen").toBeLessThan(40);
    expect(reports).not.toContain(true);
    expect(readTimelinePosition(thread)?.atEnd).toBe(false);

    const widened = scroller.scrollHeight;
    await screen.rerender(<MessagesTimeline {...base!} timelineEntries={entries("  \nmore")} />);
    await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(widened));
    await settle(() => `${scroller.scrollTop}|${scroller.scrollHeight}`);
    expect(range(), "scroll range after the size change").toBeLessThan(40);
    expect(reports).not.toContain(true);
    expect(readTimelinePosition(thread)?.atEnd).toBe(false);
  });

  it("stays at the end when the chat narrows while following", async () => {
    await using screen = await renderTimeline(WIDE, (listRef) => (
      <MessagesTimeline {...props(listRef)} timelineEntries={rows} liveFollowEnabled />
    ));
    const scroller = screen.scroller();
    await vi.waitFor(() => expect(distanceFromEnd(scroller)).toBeLessThanOrEqual(1));
    await settle(() => `${scroller.scrollTop}|${scroller.scrollHeight}`);
    const height = scroller.scrollHeight;
    screen.container.style.width = NARROW;
    await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(height));
    await settle(() => `${scroller.scrollTop}|${scroller.scrollHeight}`);
    expect(distanceFromEnd(scroller)).toBeLessThanOrEqual(1);
  });
});
