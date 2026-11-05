import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { workstreamColor } from "./loomKinds";
import { loomScale, panLoomView, type LoomView } from "./loomScale";
import { spindleGeometry, spindleLayout, strandPath } from "./loomSpindle";
import { strandColors, type Weave, type Workstream } from "./loomWeave";

const MINIMAP_HEIGHT = 56;

/**
 * The whole window at spindle scale with the view drawn over it. Drag the view to pan, click
 * elsewhere to centre it there, and use the arrow keys when it has focus.
 */
export function LoomMinimap(props: {
  readonly weave: Weave;
  readonly spine: Workstream | null;
  readonly bounds: LoomView;
  readonly view: LoomView;
  readonly onViewChange: (view: LoomView) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to this element's size through a ResizeObserver
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    setWidth(element.getBoundingClientRect().width);
    return observeResize(element, (entries) => {
      const entry = entries.at(-1);
      if (entry) setWidth(entry.contentRect.width);
    });
  }, []);
  const { weave, spine, bounds, view } = props;
  const scale = loomScale(bounds, width);
  const layout = spindleLayout(weave, spine, MINIMAP_HEIGHT);
  const colors = strandColors(weave, spine);
  const strands = (() => {
    const tailX = Math.min(scale.x(weave.tailMs), width);
    const startX = Math.max(scale.x(weave.startMs), 0);
    const geometry = spindleGeometry(width, MINIMAP_HEIGHT, startX, tailX);
    return weave.workstreams.flatMap((workstream) =>
      workstream.strands.flatMap((strand) => {
        const homeY = layout.homeY.get(strand.threadId);
        if (homeY === undefined) return [];
        const active =
          strand.extent === null
            ? ""
            : strandPath(
                geometry,
                homeY,
                Math.max(startX, scale.x(strand.extent.startMs)),
                Math.min(tailX, scale.x(strand.extent.endMs)),
              );
        return [
          {
            threadId: strand.threadId,
            warp: strandPath(geometry, homeY, startX, tailX),
            active,
            spine: strand.threadId === spine?.rootId,
            colorIndex: colors.get(strand.threadId) ?? workstream.colorIndex,
          },
        ];
      }),
    );
  })();

  const drag = useRef<{ x: number; view: LoomView } | null>(null);
  const span = view.toMs - view.fromMs;
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || width === 0) return;
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const ms = scale.ms(x);
    const inside = ms >= view.fromMs && ms <= view.toMs;
    const next = inside ? view : panLoomView(view, bounds, ms - span / 2 - view.fromMs);
    if (!inside) props.onViewChange(next);
    drag.current = { x: event.clientX, view: next };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (start === null) return;
    props.onViewChange(panLoomView(start.view, bounds, (event.clientX - start.x) * scale.msPerPx));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    props.onViewChange(
      panLoomView(view, bounds, (event.key === "ArrowLeft" ? -1 : 1) * span * 0.1),
    );
  };
  const viewX = scale.x(view.fromMs);
  const viewWidth = Math.max(2, scale.x(view.toMs) - viewX);

  return (
    <div
      ref={ref}
      role="group"
      tabIndex={0}
      aria-label="Minimap. Drag the view or use the arrow keys to pan."
      className="relative shrink-0 cursor-grab touch-none select-none border-t border-border/70 bg-card outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
      style={{ height: MINIMAP_HEIGHT }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    >
      {width === 0 ? null : (
        <svg width={width} height={MINIMAP_HEIGHT} aria-hidden className="block">
          {strands.map((strand) => (
            <path
              key={`warp:${strand.threadId}`}
              d={strand.warp}
              fill="none"
              strokeWidth={0.5}
              className={cn("opacity-25", workstreamColor(strand.colorIndex).stroke)}
            />
          ))}
          {strands.map((strand) =>
            strand.active === "" ? null : (
              <path
                key={strand.threadId}
                d={strand.active}
                fill="none"
                strokeWidth={strand.spine ? 1.5 : 1.25}
                className={
                  strand.spine ? "stroke-foreground" : workstreamColor(strand.colorIndex).stroke
                }
              />
            ),
          )}
          <rect
            data-testid="loom-minimap-view"
            x={viewX}
            y={1}
            width={viewWidth}
            height={MINIMAP_HEIGHT - 2}
            rx={2}
            strokeWidth={1}
            className="fill-foreground/8 stroke-foreground/50"
          />
        </svg>
      )}
    </div>
  );
}
