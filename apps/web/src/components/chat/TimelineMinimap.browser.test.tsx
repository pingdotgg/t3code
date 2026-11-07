import { createRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render, type Screen } from "../../../test/render";
import {
  minimapCanvas,
  minimapMarkerPixels,
  paintedMinimapMarkerIndices,
} from "../../../test/minimapPixels";
import {
  clearThemeInspectorHighlights,
  clearThemeInspectorHover,
  highlightThemeRoleUsage,
} from "../settings/themeInspector";
import { TimelineMinimap, type TimelineMinimapHandle } from "./TimelineMinimap";
import type { TimelineMinimapItem } from "./timelineMinimapItems";
import { forwardWheelToTimeline } from "./timelineMinimapWheel";

function items(count = 5, prefix = "turn"): TimelineMinimapItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    rowIndex: 1 + index * 4,
    userText: `Question ${prefix}-${index}`,
    assistantText: `Answer **${prefix}-${index}**`,
  }));
}

function minimap(
  ref: ReturnType<typeof createRef<TimelineMinimapHandle>>,
  turns: ReadonlyArray<TimelineMinimapItem>,
  onSelect: (item: TimelineMinimapItem) => void,
  key = "thread-a",
) {
  return (
    <div style={{ position: "relative", width: 600, height: 600 }}>
      <TimelineMinimap
        key={key}
        ref={ref}
        items={turns}
        hasPersistentGutter
        hitStripWidth={40}
        onSelect={onSelect}
        onWheel={() => {}}
      />
    </div>
  );
}

function rail(screen: Screen) {
  return screen.container.querySelector<HTMLButtonElement>(
    'button[aria-label^="Jump to message"]',
  )!;
}

function visible(
  ref: ReturnType<typeof createRef<TimelineMinimapHandle>>,
  start: number,
  end: number,
) {
  return act(() => ref.current!.updateVisibleRange(start, end));
}

async function withMinimapPalette(run: () => Promise<void>) {
  const root = document.documentElement;
  const originalStyle = root.getAttribute("style");
  try {
    // index.css maps these roles only after a real theme has been applied.
    root.style.setProperty("--foreground", "var(--app-theme-text)");
    root.style.setProperty("--muted-foreground", "var(--app-theme-muted-foreground)");
    root.style.setProperty("--app-theme-text", "#ff0000");
    root.style.setProperty("--app-theme-muted-foreground", "#0000ff");
    root.style.setProperty("--appearance-contrast-base", "100%");
    root.style.setProperty("--appearance-contrast-boost", "0%");
    await run();
  } finally {
    clearThemeInspectorHighlights();
    clearThemeInspectorHover();
    if (originalStyle === null) root.removeAttribute("style");
    else root.setAttribute("style", originalStyle);
  }
}

function minimapWidthFrames() {
  const requestFrame = window.requestAnimationFrame.bind(window);
  const cancelFrame = window.cancelAnimationFrame.bind(window);
  const matchMedia = window.matchMedia.bind(window);
  const pending = new Map<number, FrameRequestCallback>();
  const canceled: number[] = [];
  const motionQueries: MediaQueryList[] = [];
  let reducedMotion = false;
  let requests = 0;
  const motionSpy = vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const media = matchMedia(query);
    if (query === "(prefers-reduced-motion: reduce)") {
      Object.defineProperty(media, "matches", { configurable: true, get: () => reducedMotion });
      motionQueries.push(media);
    }
    return media;
  });
  const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
    if (pending.delete(frame)) canceled.push(frame);
    cancelFrame(frame);
  });
  const requestSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    // Like the parent's pending-refresh test, intercept only this callback body.
    // These local names are fragile across source edits or test transforms.
    const source = callback.toString();
    if (
      !/rail\.frame\s*=\s*null/.test(source) ||
      !/rail\.widths/.test(source) ||
      !/rebuildCanvasRail\s*\(/.test(source)
    ) {
      return requestFrame(callback);
    }
    // Use a native ID to avoid collisions, but prevent native delivery immediately.
    const frame = requestFrame(callback);
    cancelFrame(frame);
    requests += 1;
    pending.set(frame, callback);
    return frame;
  });
  const at = async (now: number, run: () => void) => {
    // Only seed the interaction/commit being tested. No fake timers or frozen
    // browser clock outside this act; RAF receives its timestamp explicitly.
    using _nowSpy = vi.spyOn(performance, "now").mockReturnValue(now);
    await act(run);
  };
  return {
    pending,
    canceled,
    get requests() {
      return requests;
    },
    at,
    reduceMotion(value: boolean) {
      reducedMotion = value;
      for (const media of motionQueries) media.dispatchEvent(new Event("change"));
    },
    async tick(now: number) {
      expect(pending.size, "exactly one width RAF must be queued").toBe(1);
      const [frame, callback] = pending.entries().next().value!;
      pending.delete(frame);
      await at(now, () => callback(now));
    },
    [Symbol.dispose]() {
      for (const frame of pending.keys()) cancelFrame(frame);
      pending.clear();
      requestSpy.mockRestore();
      cancelSpy.mockRestore();
      motionSpy.mockRestore();
    },
  };
}

function captureMinimapBackings() {
  const canvases = new Set<HTMLCanvasElement>();
  const beginPath = CanvasRenderingContext2D.prototype.beginPath;
  const capture = vi
    .spyOn(CanvasRenderingContext2D.prototype, "beginPath")
    .mockImplementation(function (this: CanvasRenderingContext2D) {
      canvases.add(this.canvas);
      beginPath.call(this);
    });
  return {
    get(container: ParentNode) {
      capture.mockRestore();
      const display = minimapCanvas(container);
      const base = [...canvases].find((canvas) => canvas !== display && !canvas.isConnected);
      expect(base).toBeDefined();
      return { display, base: base! };
    },
    [Symbol.dispose]: () => capture.mockRestore(),
  };
}

function backingPixels(canvas: HTMLCanvasElement) {
  return Array.from(canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data);
}

function pointMinimapAt(screen: Screen, fraction: number) {
  const button = rail(screen);
  const bounds = button.getBoundingClientRect();
  button.dispatchEvent(
    new MouseEvent("mousemove", {
      bubbles: true,
      clientY: bounds.top + bounds.height * fraction,
    }),
  );
}

function leaveMinimap(screen: Screen) {
  // React derives onMouseLeave from mouseout, not a native mouseleave event.
  rail(screen).dispatchEvent(
    new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
  );
}

function minimapWidthFootprint(container: ParentNode, count: number, index: number) {
  // Compare painted coverage, allowing the active color to change on retarget.
  return Array.from(
    { length: 24 },
    (_, x) => minimapMarkerPixels(container, count, x)[index]![3]! > 0,
  );
}

describe("TimelineMinimap", () => {
  it("animates width in both 150ms directions and stops through scroll-only updates", async () => {
    await withMinimapPalette(async () => {
      using frames = minimapWidthFrames();
      const ref = createRef<TimelineMinimapHandle>();
      await using screen = await render(minimap(ref, items(), () => {}));
      const alpha = (x: number) => minimapMarkerPixels(screen.container, 5, x)[2]![3]!;
      await visible(ref, 9, 9);
      expect(alpha(6)).toBeGreaterThan(160);
      expect(alpha(10)).toBe(0);
      await visible(ref, 1, 1);
      await visible(ref, 9, 9);
      expect(frames.requests).toBe(0);

      await frames.at(1_000, () => pointMinimapAt(screen, 0.5));
      expect(frames.pending.size, "hover must match and queue the width callback").toBe(1);
      expect(alpha(6)).toBeGreaterThan(160);
      expect(alpha(10)).toBe(0); // Still the original 8px tick at the start.
      await frames.tick(1_075);
      expect(alpha(18)).toBeGreaterThan(160);
      expect(alpha(22)).toBe(0); // Between 8 and 24, with the original eased motion.
      await frames.tick(1_149);
      expect(frames.pending.size).toBe(1);
      await frames.tick(1_150);
      expect(alpha(22)).toBeGreaterThan(160);
      expect(frames.pending.size).toBe(0);

      const settledRequests = frames.requests;
      await visible(ref, 13, 13); // Changes currentIndex as well as highlight pixels.
      expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([3]);
      expect(alpha(22)).toBeGreaterThan(0); // Settled hover width survives scrolling.
      await visible(ref, 9, 9);
      expect(frames.requests).toBe(settledRequests);
      expect(frames.pending.size).toBe(0);

      await frames.at(1_200, () => leaveMinimap(screen));
      expect(frames.pending.size).toBe(1);
      expect(alpha(22)).toBeGreaterThan(160);
      await frames.tick(1_275);
      expect(alpha(9)).toBeGreaterThan(160);
      expect(alpha(14)).toBe(0);
      await frames.tick(1_349);
      expect(frames.pending.size).toBe(1);
      await frames.tick(1_350);
      expect(alpha(6)).toBeGreaterThan(160);
      expect(alpha(10)).toBe(0);
      expect(frames.pending.size).toBe(0);
      const finishedRequests = frames.requests;
      await visible(ref, 1, 1);
      await visible(ref, 17, 17);
      expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([4]);
      expect(frames.requests).toBe(finishedRequests);
      expect(frames.pending.size).toBe(0);
    });
  });

  it("retargets from painted widths without extending unchanged targets and cancels on unmount", async () => {
    await withMinimapPalette(async () => {
      using frames = minimapWidthFrames();
      const ref = createRef<TimelineMinimapHandle>();
      await using screen = await render(minimap(ref, items(), () => {}));
      await visible(ref, 9, 9);
      const footprints = () =>
        [2, 4].map((index) => minimapWidthFootprint(screen.container, 5, index));
      await frames.at(2_000, () => pointMinimapAt(screen, 0.5));
      await frames.tick(2_075);
      const beforeRetarget = footprints();
      await frames.at(2_075, () => pointMinimapAt(screen, 1));
      expect(footprints()).toEqual(beforeRetarget);
      expect(frames.pending.size).toBe(1);
      await frames.tick(2_075);
      expect(footprints()).toEqual(beforeRetarget); // The first retarget frame must not snap either.
      await frames.tick(2_150);
      // Index 3 is a neighbor of both active markers. Its 16px destination did
      // not change, so the original deadline still applies.
      expect(minimapMarkerPixels(screen.container, 5, 14)[3]![3]).toBeGreaterThan(0);
      expect(minimapMarkerPixels(screen.container, 5, 18)[3]![3]).toBe(0);
      const neighborAtOriginalDeadline = Array.from(
        { length: 24 },
        (_, x) => minimapMarkerPixels(screen.container, 5, x)[3],
      );
      expect(frames.pending.size).toBe(1);
      await frames.tick(2_225);
      expect(
        Array.from({ length: 24 }, (_, x) => minimapMarkerPixels(screen.container, 5, x)[3]),
      ).toEqual(neighborAtOriginalDeadline);
      expect(minimapMarkerPixels(screen.container, 5, 12)[2]![3]).toBe(0);
      expect(minimapMarkerPixels(screen.container, 5, 22)[4]![3]).toBeGreaterThan(0);
      expect(frames.pending.size).toBe(0);

      await frames.at(2_250, () => pointMinimapAt(screen, 0.5));
      await frames.tick(2_325);
      const beforeLeave = footprints();
      await frames.at(2_325, () => leaveMinimap(screen));
      expect(footprints()).toEqual(beforeLeave);
      await frames.tick(2_325);
      expect(footprints()).toEqual(beforeLeave);
      const pendingFrame = [...frames.pending.keys()][0]!;
      expect(frames.pending.size).toBe(1);
      const canvas = minimapCanvas(screen.container);
      await screen.unmount();
      expect(frames.canceled).toContain(pendingFrame);
      expect(frames.pending.size).toBe(0);
      expect(canvas.width).toBe(0);
      expect(canvas.height).toBe(0);
    });
  });

  it.each([
    { lost: ["display"], restored: ["display"] },
    { lost: ["base"], restored: ["base"] },
    { lost: ["display", "base"], restored: ["display", "base"] },
    { lost: ["display", "base"], restored: ["base", "display"] },
  ] as const)(
    "recovers lost $lost backings in $restored order at equal geometry",
    async ({ lost, restored }) => {
      await withMinimapPalette(async () => {
        const ref = createRef<TimelineMinimapHandle>();
        using capture = captureMinimapBackings();
        await using screen = await render(minimap(ref, items(), () => {}));
        const backings = capture.get(screen.container);
        const targets = Object.values(backings);
        await visible(ref, 5, 9);
        const expected = targets.map(backingPixels);
        expect(expected.every((pixels) => pixels.some((value) => value !== 0))).toBe(true);
        await act(() => {
          for (const name of lost) {
            const target = backings[name];
            target.dispatchEvent(new Event("contextlost", { cancelable: true }));
            // Events alone reset neither actual pixels nor drawing state.
            const width = target.width;
            target.width = width;
            expect(backingPixels(target).every((value) => value === 0)).toBe(true);
          }
        });
        const duringLoss = targets.map(backingPixels);
        await visible(ref, 13, 13);
        expect(targets.map(backingPixels)).toEqual(duringLoss);
        for (const [index, name] of restored.entries()) {
          // Recover the original range while painting is still blocked.
          await visible(ref, 5, 9);
          expect(targets.map(backingPixels)).toEqual(duringLoss);
          await act(() => backings[name].dispatchEvent(new Event("contextrestored")));
          if (index < restored.length - 1) {
            expect(targets.map(backingPixels)).toEqual(duringLoss);
            await visible(ref, 13, 13);
            expect(targets.map(backingPixels)).toEqual(duringLoss);
          }
        }
        expect(targets.map(backingPixels)).toEqual(expected);
        expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([1, 2]);
      });
    },
  );

  it("keeps the painted neighbor width across adjacent retargets without an intervening frame", async () => {
    await withMinimapPalette(async () => {
      // Exercise the overlapping neighborhoods in both traversal directions.
      for (const [initialIndex, finalIndex] of [
        [5, 7],
        [7, 5],
      ] as const) {
        using frames = minimapWidthFrames();
        const ref = createRef<TimelineMinimapHandle>();
        const count = 9;
        await using screen = await render(minimap(ref, items(count), () => {}));
        const footprint = (index: number) => minimapWidthFootprint(screen.container, count, index);
        const alpha = (index: number, x: number) =>
          minimapMarkerPixels(screen.container, count, x)[index]![3]!;

        await frames.at(4_000, () => pointMinimapAt(screen, initialIndex / (count - 1)));
        await frames.tick(4_150);
        expect(frames.pending.size).toBe(0);
        expect(alpha(initialIndex, 22)).toBeGreaterThan(0); // Settled 24px active marker.
        expect(alpha(6, 14)).toBeGreaterThan(0);
        expect(alpha(6, 18)).toBe(0); // Its neighbor has painted 16px, never 24px.
        const painted16 = footprint(6);
        const painted24 = footprint(initialIndex);

        await frames.at(4_200, () => pointMinimapAt(screen, 6 / (count - 1)));
        expect(footprint(6)).toEqual(painted16);
        expect(frames.pending.size).toBe(1);
        // Separate React commits, but no width frame between the adjacent moves.
        await frames.at(4_200, () => pointMinimapAt(screen, finalIndex / (count - 1)));
        expect(footprint(6)).toEqual(painted16);
        expect(alpha(6, 18)).toBe(0);
        expect(frames.pending.size).toBe(1);
        await frames.tick(4_200);
        expect(footprint(6)).toEqual(painted16); // Same-timestamp frame cannot resurrect 24px.
        expect(alpha(6, 18)).toBe(0);
        await frames.tick(4_349);
        expect(footprint(6)).toEqual(painted16);
        expect(frames.pending.size).toBe(1);
        await frames.tick(4_350);
        expect(footprint(finalIndex)).toEqual(painted24);
        expect(alpha(finalIndex, 22)).toBeGreaterThan(0);
        expect(footprint(6)).toEqual(painted16);
        expect(alpha(6, 14)).toBeGreaterThan(0);
        expect(alpha(6, 18)).toBe(0);
        expect(frames.pending.size).toBe(0);

        const settledRequests = frames.requests;
        await visible(ref, 1, 1);
        await visible(ref, 1 + finalIndex * 4, 1 + finalIndex * 4);
        expect(paintedMinimapMarkerIndices(screen.container, count)).toEqual([finalIndex]);
        expect(footprint(finalIndex)).toEqual(painted24);
        expect(footprint(6)).toEqual(painted16);
        expect(frames.requests).toBe(settledRequests);
        expect(frames.pending.size).toBe(0);
      }
    });
  });

  it("snaps and cancels width motion when reduced motion changes", async () => {
    await withMinimapPalette(async () => {
      using frames = minimapWidthFrames();
      const ref = createRef<TimelineMinimapHandle>();
      await using screen = await render(minimap(ref, items(), () => {}));
      const alpha = (x: number) => minimapMarkerPixels(screen.container, 5, x)[2]![3]!;
      await visible(ref, 9, 9);
      await frames.at(5_000, () => pointMinimapAt(screen, 0.5));
      expect(frames.pending.size).toBe(1);
      expect(alpha(20)).toBe(0);
      await act(() => frames.reduceMotion(true));
      expect(frames.pending.size).toBe(0);
      expect(frames.canceled.length).toBeGreaterThan(0);
      expect(alpha(20)).toBeGreaterThan(160);
      const requests = frames.requests;
      await act(() => leaveMinimap(screen));
      expect(alpha(20)).toBe(0);
      await act(() => pointMinimapAt(screen, 0.5));
      expect(alpha(20)).toBeGreaterThan(160);
      expect(frames.requests).toBe(requests);
      await act(() => frames.reduceMotion(false));
      await frames.at(5_200, () => leaveMinimap(screen));
      expect(frames.pending.size).toBe(1);
      await frames.tick(5_350);
      expect(alpha(20)).toBe(0);
      expect(frames.pending.size).toBe(0);
    });
  });

  it("highlights only visible user markers and navigates around the first visible turn", async () => {
    const ref = createRef<TimelineMinimapHandle>();
    const turns = items();
    const onSelect = vi.fn();
    await using screen = await render(minimap(ref, turns, onSelect));
    await visible(ref, 5, 9);
    expect(paintedMinimapMarkerIndices(screen.container, turns.length)).toEqual([1, 2]);

    await screen.getByRole("button", { name: "Previous turn" }).click();
    expect(onSelect).toHaveBeenLastCalledWith(turns[0]);
    await screen.getByRole("button", { name: "Next turn" }).click();
    expect(onSelect).toHaveBeenLastCalledWith(turns[2]);

    await visible(ref, 6, 8);
    expect(paintedMinimapMarkerIndices(screen.container, turns.length)).toEqual([]);
    await screen.getByRole("button", { name: "Next turn" }).click();
    expect(onSelect).toHaveBeenLastCalledWith(turns[2]);

    await visible(ref, 17, 20);
    await expect.element(screen.getByRole("button", { name: "Next turn" })).toBeDisabled();
    await visible(ref, 0, 1);
    await expect.element(screen.getByRole("button", { name: "Previous turn" })).toBeDisabled();
  });

  it("keeps pointer previews, keyboard navigation, and endpoint geometry", async () => {
    const ref = createRef<TimelineMinimapHandle>();
    const turns = items();
    const onSelect = vi.fn();
    await using screen = await render(minimap(ref, turns, onSelect));
    await visible(ref, 9, 9);
    const button = rail(screen);
    const bounds = button.getBoundingClientRect();
    await act(() => pointMinimapAt(screen, 0.5));
    await expect.element(screen.getByText("Question turn-2", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Answer turn-2", { exact: true })).toBeVisible();

    await act(() => button.focus());
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: turns[3]!.id, rowIndex: turns[3]!.rowIndex }),
    );
    await userEvent.keyboard("{Home}{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: turns[0]!.id, rowIndex: turns[0]!.rowIndex }),
    );
    await userEvent.keyboard("{End} ");
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: turns[4]!.id, rowIndex: turns[4]!.rowIndex }),
    );
    await userEvent.keyboard("{ArrowUp}{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: turns[3]!.id, rowIndex: turns[3]!.rowIndex }),
    );

    await act(() => {
      button.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientY: bounds.top + bounds.height }),
      );
    });
    expect(onSelect).toHaveBeenLastCalledWith(turns[4]);
    await visible(ref, 1, 1);
    expect(paintedMinimapMarkerIndices(screen.container, turns.length)).toEqual([0]);
    await visible(ref, 17, 17);
    expect(paintedMinimapMarkerIndices(screen.container, turns.length)).toEqual([4]);
  });

  it("recomputes membership after same-count replacement and resets on a new thread key", async () => {
    const ref = createRef<TimelineMinimapHandle>();
    const turns = items();
    const onSelect = vi.fn();
    await using screen = await render(minimap(ref, turns, onSelect));
    await visible(ref, 5, 9);
    const replacement = turns.map((turn) => ({ ...turn, rowIndex: turn.rowIndex + 1 }));
    await screen.rerender(minimap(ref, replacement, onSelect));
    // Same count, new row mapping, no imperative range update.
    expect(paintedMinimapMarkerIndices(screen.container, turns.length)).toEqual([1]);

    await act(() => rail(screen).focus());
    await expect.element(screen.getByText("Question turn-1", { exact: true })).toBeVisible();

    await screen.rerender(minimap(ref, items(5, "other"), onSelect, "thread-b"));
    expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([]);
    expect(screen.container.querySelector("[data-minimap-preview]")).toBeNull();
    await expect.element(screen.getByRole("button", { name: "Previous turn" })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Next turn" })).toBeDisabled();
    await visible(ref, 9, 9);
    expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([2]);
    await screen.getByRole("button", { name: "Next turn" }).click();
    expect(onSelect).toHaveBeenLastCalledWith(items(5, "other")[3]);
  });

  it("retains the range across initial 0-to-1-to-2 items and a zero-size rail", async () => {
    await withMinimapPalette(async () => {
      const ref = createRef<TimelineMinimapHandle>();
      const turns = items(2);
      const onSelect = vi.fn();
      await using screen = await render(minimap(ref, [], onSelect));
      expect(screen.container.querySelector("[data-minimap-canvas]")).toBeNull();
      await visible(ref, 1, 5);
      await screen.rerender(minimap(ref, turns.slice(0, 1), onSelect));
      expect(screen.container.querySelector("[data-minimap-canvas]")).toBeNull();
      await screen.rerender(minimap(ref, turns, onSelect));
      await vi.waitFor(() => {
        expect(paintedMinimapMarkerIndices(screen.container, 2)).toEqual([0, 1]);
      });
      const button = rail(screen);
      const bounds = button.getBoundingClientRect();
      expect(bounds.height).toBe(8);
      for (const [index, clientY] of [
        [0, bounds.top],
        [1, bounds.bottom],
      ] as const) {
        await act(() => {
          button.dispatchEvent(new MouseEvent("click", { bubbles: true, clientY }));
        });
        expect(onSelect).toHaveBeenLastCalledWith(turns[index]);
      }

      await screen.rerender(minimap(ref, turns.slice(0, 1), onSelect));
      expect(screen.container.querySelector("[data-minimap-canvas]")).toBeNull();
      await screen.rerender(minimap(ref, turns, onSelect));
      await vi.waitFor(() => {
        expect(paintedMinimapMarkerIndices(screen.container, 2)).toEqual([0, 1]);
      });
      const canvas = minimapCanvas(screen.container);
      const geometry = canvas.parentElement!;
      const { width, height } = geometry.style;
      await act(() => {
        geometry.style.width = "0px";
        geometry.style.height = "0px";
      });
      await vi.waitFor(() => {
        expect(canvas.getBoundingClientRect().width).toBe(0);
        expect(canvas.getBoundingClientRect().height).toBe(0);
        expect(canvas.width).toBe(0);
        expect(canvas.height).toBe(0);
      });
      await act(() => {
        geometry.style.width = width;
        geometry.style.height = height;
      });
      // No range update since the empty render: resize must repaint retained rows.
      await vi.waitFor(() => {
        expect(paintedMinimapMarkerIndices(screen.container, 2)).toEqual([0, 1]);
      });
      await expect.element(screen.getByRole("button", { name: "Previous turn" })).toBeDisabled();
      await expect.element(screen.getByRole("button", { name: "Next turn" })).toBeEnabled();
      await screen.getByRole("button", { name: "Next turn" }).click();
      expect(onSelect).toHaveBeenLastCalledWith(turns[1]);
    });
  });

  it("keeps focused previews and keyboard selection on the displayed replacement", async () => {
    await withMinimapPalette(async () => {
      const ref = createRef<TimelineMinimapHandle>();
      const onSelect = vi.fn();
      await using screen = await render(minimap(ref, items(), onSelect));
      await visible(ref, 9, 9);
      const button = rail(screen);
      // Fresh keyboard focus uses the moved viewport, with no pointer preview.
      await act(() => button.focus());
      await expect.element(screen.getByText("Question turn-2", { exact: true })).toBeVisible();
      const replacement = items(5, "replacement").map((turn) => ({
        ...turn,
        rowIndex: turn.rowIndex + 4,
      }));
      await screen.rerender(minimap(ref, replacement, onSelect));
      expect(document.activeElement).toBe(button);
      // Focus is index-based: index 2 now previews and selects the replacement ID.
      await expect
        .element(screen.getByText("Question replacement-2", { exact: true }))
        .toBeVisible();
      await expect.element(screen.getByText("Answer replacement-2", { exact: true })).toBeVisible();
      await expect
        .element(screen.getByText("Question turn-2", { exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(screen.getByText("Answer turn-2", { exact: true }))
        .not.toBeInTheDocument();
      await vi.waitFor(() => {
        expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([1]);
        expect(minimapMarkerPixels(screen.container, 5, 20).map((pixel) => pixel[3]! > 0)).toEqual([
          false,
          false,
          true,
          false,
          false,
        ]);
      });
      await userEvent.keyboard("{Enter}");
      expect(onSelect).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "replacement-2", rowIndex: 13 }),
      );
      const updated = replacement.map((turn, index) =>
        index === 2 ? { ...turn, assistantText: "Updated **replacement** answer" } : turn,
      );
      await screen.rerender(minimap(ref, updated, onSelect));
      await expect
        .element(screen.getByText("Updated replacement answer", { exact: true }))
        .toBeVisible();
      await expect
        .element(screen.getByText("Answer replacement-2", { exact: true }))
        .not.toBeInTheDocument();
      await userEvent.keyboard(" ");
      expect(onSelect).toHaveBeenLastCalledWith(
        expect.objectContaining({
          id: "replacement-2",
          rowIndex: 13,
          assistantText: "Updated replacement answer",
        }),
      );

      await act(() => button.blur());
      expect(screen.container.querySelector("[data-minimap-preview]")).toBeNull();
      await visible(ref, 17, 17);
      await act(() => button.focus());
      await expect
        .element(screen.getByText("Question replacement-3", { exact: true }))
        .toBeVisible();
      await vi.waitFor(() => {
        expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([3]);
        expect(minimapMarkerPixels(screen.container, 5, 20)[3]![3]).toBeGreaterThan(200);
      });
      await userEvent.keyboard("{Enter}");
      expect(onSelect).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "replacement-3", rowIndex: 17 }),
      );
    });
  });

  it("clears highlight pixels and navigation for unknown bounds and restores the same range", async () => {
    await withMinimapPalette(async () => {
      const ref = createRef<TimelineMinimapHandle>();
      const turns = items();
      const onSelect = vi.fn();
      await using screen = await render(minimap(ref, turns, onSelect));
      await visible(ref, 9, 9);
      expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([2]);
      await act(() => ref.current!.updateVisibleRange(null, null));
      await vi.waitFor(() => {
        expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([]);
        for (const pixel of minimapMarkerPixels(screen.container, 5)) {
          expect(pixel[2]).toBeGreaterThan(200);
          expect(pixel[3]).toBeGreaterThan(0);
          expect(pixel[3]).toBeLessThanOrEqual(153);
        }
      });
      await expect.element(screen.getByRole("button", { name: "Previous turn" })).toBeDisabled();
      await expect.element(screen.getByRole("button", { name: "Next turn" })).toBeDisabled();
      await visible(ref, 9, 9);
      await vi.waitFor(() => {
        expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([2]);
      });
      await expect.element(screen.getByRole("button", { name: "Previous turn" })).toBeEnabled();
      await expect.element(screen.getByRole("button", { name: "Next turn" })).toBeEnabled();
      await screen.getByRole("button", { name: "Previous turn" }).click();
      expect(onSelect).toHaveBeenLastCalledWith(turns[1]);
      await screen.getByRole("button", { name: "Next turn" }).click();
      expect(onSelect).toHaveBeenLastCalledWith(turns[3]);
    });
  });

  it("repaints an unchanged range after size and palette changes", async () => {
    await withMinimapPalette(async () => {
      const ref = createRef<TimelineMinimapHandle>();
      await using screen = await render(minimap(ref, items(), () => {}));
      await visible(ref, 9, 9);
      const canvas = minimapCanvas(screen.container);
      const before = minimapMarkerPixels(screen.container, 5);
      expect(before[2]![0]).toBeGreaterThan(160);
      expect(before[2]![3]).toBeGreaterThan(160);
      expect(before[0]![2]).toBeGreaterThan(200);
      expect(before[0]![3]).toBeLessThanOrEqual(153);
      expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([2]);

      await act(() => {
        canvas.parentElement!.style.height = "64px";
      });
      await vi.waitFor(() => {
        expect(canvas.getBoundingClientRect().height).toBe(66);
        expect(canvas.height).toBe(Math.ceil(66 * (window.devicePixelRatio || 1)));
        expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([2]);
      });

      await act(() => {
        document.documentElement.style.setProperty("--app-theme-text", "#00ff00");
        document.documentElement.style.setProperty("--app-theme-muted-foreground", "#ff0000");
      });
      await vi.waitFor(() => {
        const after = minimapMarkerPixels(screen.container, 5);
        expect(after[2]![1]).toBeGreaterThan(160);
        expect(after[0]![0]).toBeGreaterThan(200);
        expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([2]);
      });
    });
  });

  it("reports visible canvas usage synchronously and omits empty highlight paint", async () => {
    await withMinimapPalette(async () => {
      const MUTED = "mutedForeground";
      const FORE = "text";
      const matchAttribute = "data-theme-inspector-match";
      const ref = createRef<TimelineMinimapHandle>();
      await using screen = await render(minimap(ref, items(), () => {}));
      const canvas = minimapCanvas(screen.container);
      expect(canvas.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(canvas.getBoundingClientRect().height).toBeGreaterThan(0);
      expect(getComputedStyle(canvas).display).not.toBe("none");

      await act(() => {
        // No await between range/probe/restore calls: the canvas theme observer
        // cannot run in the middle of this synchronous inspection.
        ref.current!.updateVisibleRange(5, 9);
        highlightThemeRoleUsage([MUTED]);
        expect(canvas.hasAttribute(matchAttribute)).toBe(true);
        highlightThemeRoleUsage([FORE]);
        expect(canvas.hasAttribute(matchAttribute)).toBe(true);

        ref.current!.updateVisibleRange(6, 8);
        highlightThemeRoleUsage([FORE]);
        expect(canvas.hasAttribute(matchAttribute)).toBe(false);
        ref.current!.updateVisibleRange(null, null);
        highlightThemeRoleUsage([FORE]);
        expect(canvas.hasAttribute(matchAttribute)).toBe(false);
        highlightThemeRoleUsage([MUTED]);
        expect(canvas.hasAttribute(matchAttribute)).toBe(true);

        ref.current!.updateVisibleRange(9, 9);
        highlightThemeRoleUsage([FORE]);
        expect(canvas.hasAttribute(matchAttribute)).toBe(true);
      });
    });
  });

  it("lets an outside selection drag pass through and restores the hit target on release", async () => {
    const ref = createRef<TimelineMinimapHandle>();
    await using screen = await render(minimap(ref, items(), () => {}));
    const hitTarget = rail(screen).parentElement!;
    await act(() => {
      hitTarget.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1 }));
    });
    expect(getComputedStyle(hitTarget).pointerEvents).toBe("none");
    await act(() => {
      window.dispatchEvent(new MouseEvent("mouseup", { buttons: 0 }));
    });
    expect(getComputedStyle(hitTarget).pointerEvents).toBe("auto");
  });

  it("forwards wheel scrolling from the rail to the timeline", async () => {
    const ref = createRef<TimelineMinimapHandle>();
    const viewport = createRef<HTMLDivElement>();
    await using screen = await render(
      <div style={{ position: "relative", width: 600, height: 600 }}>
        <div ref={viewport} style={{ height: 100, overflow: "auto" }}>
          <div style={{ height: 2_000 }} />
        </div>
        <TimelineMinimap
          ref={ref}
          items={items()}
          hasPersistentGutter
          hitStripWidth={40}
          onSelect={() => {}}
          onWheel={(event) => forwardWheelToTimeline(event, viewport.current!)}
        />
      </div>,
    );
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 80 });
    await act(() => {
      rail(screen).dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(viewport.current!.scrollTop).toBe(80);
  });
});
