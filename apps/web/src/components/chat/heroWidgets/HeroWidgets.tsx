import { useLayoutEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { useUsage } from "../../../state/usage";
import { dailyWindow, fitHeroLayout, HERO_LAYOUT, type LowerWidgetId } from "./heroWidgets.logic";
import { MachinesWidget } from "./MachinesWidget";
import { PoolWidget } from "./PoolWidget";
import { STREAK_SPAN_DAYS, StreakWidget } from "./StreakWidget";
import { useNow } from "./widgetChrome";

/** Horizontal breathing room between the widget grid and the edges of the chat pane. */
const PANE_GUTTER = 48;
/** The grid never grows wider than this, so the pool chart keeps a readable week. */
const MAX_WIDTH = 1360;
/** Space between the composer row and the widget grid. */
const GAP_ABOVE = 32;
/** Least room left for the hero headline, which fills the pane above the composer. */
const HEADLINE_SPACE = 112;
/** Space kept between the widget grid and the bottom of the pane. */
const EDGE_MARGIN = 24;

/**
 * Widgets under the new-chat composer: Pool across the top, Machines and Streak below. The grid
 * never scrolls and drops the widgets that do not fit. It reserves its rendered height as bottom
 * margin on the composer stack (a CSS variable on the overlay), lifting the bottom-docked composer
 * above it.
 */
export function HeroWidgets() {
  const now = useNow(30_000);
  // One day-resolution call serves the streak, the heatmap and the pool's burn rate.
  const [historyWindow] = useState(() => dailyWindow(new Date(), STREAK_SPAN_DAYS));
  const history = useUsage(historyWindow);
  const daily = (history.shown?.merged ?? history.merged).daily;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [space, setSpace] = useState<{ width: number; height: number } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sizes the grid to the chat pane left around the composer
  useLayoutEffect(() => {
    const container = containerRef.current;
    const stack = container?.parentElement;
    const overlay = container?.closest<HTMLElement>('[data-chat-composer-overlay="true"]');
    if (!container || !stack || !overlay) return;
    const measure = () => {
      const pane = overlay.getBoundingClientRect();
      const stackHeight = stack.getBoundingClientRect().height;
      setSpace({
        width: Math.max(0, Math.min(MAX_WIDTH, Math.floor(pane.width - PANE_GUTTER * 2))),
        height: Math.max(
          0,
          Math.floor(pane.height - stackHeight - HEADLINE_SPACE - GAP_ABOVE - EDGE_MARGIN),
        ),
      });
    };
    measure();
    return observeResize([overlay, stack], measure);
  }, []);

  const layout = space === null ? null : fitHeroLayout(space);
  const renderedHeight = layout?.height ?? 0;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the grid's height to the overlay so the composer stack sits above it
  useLayoutEffect(() => {
    const overlay = containerRef.current?.closest<HTMLElement>(
      '[data-chat-composer-overlay="true"]',
    );
    if (!overlay) return;
    overlay.style.setProperty(
      "--hero-widgets-below",
      `${renderedHeight > 0 ? renderedHeight + GAP_ABOVE + EDGE_MARGIN : 0}px`,
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
      className="absolute top-full left-1/2 -translate-x-1/2"
      style={space === null ? undefined : { width: space.width, marginTop: GAP_ABOVE }}
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
