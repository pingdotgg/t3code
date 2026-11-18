import { useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { useUsage } from "../../../state/usage";
import { useChatCanvas } from "../ChatCanvasContext";
import {
  dailyWindow,
  fitHeroLayout,
  HERO_AREA,
  HERO_LAYOUT,
  type HeroArea,
  heroWidgetArea,
  type LowerWidgetId,
} from "./heroWidgets.logic";
import { MachinesWidget } from "./MachinesWidget";
import { PoolWidget } from "./PoolWidget";
import { STREAK_SPAN_DAYS, StreakWidget } from "./StreakWidget";
import { useNow } from "./widgetChrome";

const PANE = '[data-chat-composer-overlay="true"], [data-new-tab-launcher]';

/** Left edge inside `frame` from layout offsets, so a sidebar slide's transform never counts. */
function offsetLeftIn(element: HTMLElement, frame: Element): number | null {
  let left = 0;
  let node: Element | null = element;
  while (node instanceof HTMLElement && node !== frame) {
    left += node.offsetLeft;
    node = node.offsetParent;
  }
  return node === frame ? left : null;
}

/** Room the headline lane needs to show whole, counting what its list scrolls away when squeezed. */
function headlineHeight(lane: HTMLElement): number {
  const content = lane.firstElementChild;
  // The short-pane container query hides the lane.
  if (!(content instanceof HTMLElement) || lane.offsetParent === null) return 0;
  let clipped = 0;
  for (const element of content.querySelectorAll<HTMLElement>("*")) {
    if (element.scrollHeight <= element.clientHeight) continue;
    const { overflowY } = getComputedStyle(element);
    if (overflowY === "auto" || overflowY === "scroll") {
      clipped += element.scrollHeight - element.clientHeight;
    }
  }
  const style = getComputedStyle(lane);
  return (
    content.offsetHeight +
    clipped +
    Number.parseFloat(style.paddingTop) +
    Number.parseFloat(style.paddingBottom)
  );
}

/**
 * Pool, Machines and Streak under the new-chat composer or a new tab's list. The grid never scrolls
 * and drops what does not fit, reserves its height as bottom margin on the stack above it (a CSS
 * variable on the pane), and centers in the visible pane rather than on the stack's lane.
 */
export function HeroWidgets() {
  const now = useNow(30_000);
  // One day-resolution call serves the streak, the heatmap and the pool's burn rate.
  const [historyWindow] = useState(() => dailyWindow(new Date(), STREAK_SPAN_DAYS));
  const history = useUsage(historyWindow);
  const daily = (history.shown?.merged ?? history.merged).daily;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [space, setSpace] = useState<HeroArea | null>(null);
  const canvas = useChatCanvas();

  const measure = useEffectEvent(() => {
    const container = containerRef.current;
    const stack = container?.parentElement;
    const overlay = container?.closest<HTMLElement>(PANE);
    const frame = overlay?.offsetParent;
    if (!stack || !overlay || !frame) return;
    const overlayLeft = offsetLeftIn(overlay, frame) ?? 0;
    const lane = overlay.firstElementChild;
    const details = overlay
      .closest("[data-chat-canvas]")
      ?.querySelector<HTMLElement>('[data-thread-details-panel="inline"]');
    const detailsLeft = details ? offsetLeftIn(details, frame) : null;
    const style = getComputedStyle(overlay);
    const next = heroWidgetArea({
      width: overlay.clientWidth,
      height:
        overlay.clientHeight -
        Number.parseFloat(style.paddingTop) -
        Number.parseFloat(style.paddingBottom),
      stackLeft: (offsetLeftIn(stack, frame) ?? overlayLeft) - overlayLeft,
      stackHeight: stack.offsetHeight,
      headlineHeight:
        lane instanceof HTMLElement && !lane.contains(stack) ? headlineHeight(lane) : 0,
      detailsLeft: detailsLeft === null ? null : detailsLeft - overlayLeft,
    });
    setSpace((previous) =>
      previous?.left === next.left &&
      previous.width === next.width &&
      previous.height === next.height
        ? previous
        : next,
    );
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sizes the grid to the pane left around the headline and composer
  useLayoutEffect(() => {
    const container = containerRef.current;
    const stack = container?.parentElement;
    const overlay = container?.closest<HTMLElement>(PANE);
    if (!stack || !overlay) return;
    const headline = overlay.firstElementChild?.firstElementChild;
    measure();
    return observeResize(
      headline && !headline.contains(stack) ? [overlay, stack, headline] : [overlay, stack],
      () => measure(),
    );
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-measures after the chat canvas lays out again
  useLayoutEffect(() => {
    measure();
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The canvas re-renders when the details card opens or the composer lane moves without resizing, which no resize observer reports.
    canvas,
  ]);

  const layout = space === null ? null : fitHeroLayout(space);
  const renderedHeight = layout?.height ?? 0;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the grid's height to the overlay so the composer stack sits above it
  useLayoutEffect(() => {
    const overlay = containerRef.current?.closest<HTMLElement>(PANE);
    if (!overlay) return;
    overlay.style.setProperty(
      "--hero-widgets-below",
      `${renderedHeight > 0 ? renderedHeight + HERO_AREA.gapAbove + HERO_AREA.edgeMargin : 0}px`,
    );
    return () => {
      overlay.style.removeProperty("--hero-widgets-below");
    };
  }, [renderedHeight]);

  const renderLower = (id: LowerWidgetId) =>
    id === "machines" ? (
      <MachinesWidget now={now} />
    ) : (
      <StreakWidget now={now} daily={daily} pending={history.isPending} />
    );

  return (
    <div
      ref={containerRef}
      data-hero-widgets
      className="absolute top-full"
      style={
        space === null || layout === null
          ? undefined
          : { left: space.left, width: space.width, marginTop: HERO_AREA.gapAbove }
      }
    >
      {layout === null ? null : (
        <div className="flex flex-col" style={{ gap: HERO_LAYOUT.gap }}>
          <div className="min-h-0" style={{ height: layout.poolHeight }}>
            <PoolWidget now={now} daily={daily} />
          </div>
          {layout.lowerRows.map((row) => (
            <div
              key={row.join(":")}
              className="grid min-h-0"
              style={{
                height: layout.lowerHeight,
                gap: HERO_LAYOUT.gap,
                gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))`,
              }}
            >
              {row.map((id) => (
                <div key={id} className="min-h-0">
                  {renderLower(id)}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
