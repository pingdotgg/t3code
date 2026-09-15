import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useResizeDrag } from "~/hooks/useResizeDrag";
import {
  constrainPaneSizes,
  equalPaneSizes,
  MIN_TERMINAL_PANE_PX,
  paneBoundaryOffsets,
  paneGridTemplate,
  panePixelBoundaries,
  resizeAdjacentPanes,
  resolvePaneSizes,
  snapPaneSizesToWholePixels,
  type TerminalSplitDirection,
} from "~/terminal/splitPaneSizes";

interface TerminalSplitPanesProps {
  terminalIds: readonly string[];
  direction: TerminalSplitDirection;
  activeTerminalId: string;
  sizes: readonly number[] | undefined;
  onSizesChange: (sizes: number[]) => void;
  onPaneActivate: (terminalId: string) => void;
  onResizeEnd: () => void;
  renderTerminal: (terminalId: string) => ReactNode;
}

function sizesDiffer(left: readonly number[], right: readonly number[]) {
  return left.some((size, index) => size !== right[index]);
}

/** Renders terminal panes with frame-synchronous, directly manipulated split handles. */
export function TerminalSplitPanes({
  terminalIds,
  direction,
  activeTerminalId,
  sizes,
  onSizesChange,
  onPaneActivate,
  onResizeEnd,
  renderTerminal,
}: TerminalSplitPanesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const containerPxRef = useRef(0);
  const renderedContainerPxRef = useRef(0);
  const [containerPx, setContainerPx] = useState(0);
  const latestSizesRef = useRef<number[]>([]);
  const draggingRef = useRef(false);
  const handleStateRef = useRef<Array<HTMLDivElement | null>>([]);
  const callbacksRef = useRef({ onSizesChange, onResizeEnd });
  useLayoutEffect(() => {
    callbacksRef.current = { onSizesChange, onResizeEnd };
  }, [onSizesChange, onResizeEnd]);

  const resolved = resolvePaneSizes(sizes, terminalIds.length);
  const resolvedRef = useRef(resolved);
  const displayed = constrainPaneSizes(resolved, containerPx, MIN_TERMINAL_PANE_PX[direction]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const nextContainerPx =
        direction === "horizontal" ? entry.contentRect.width : entry.contentRect.height;
      containerPxRef.current = nextContainerPx;
      const currentSizes = resolvedRef.current;
      const minimum = MIN_TERMINAL_PANE_PX[direction];
      const previous = constrainPaneSizes(currentSizes, renderedContainerPxRef.current, minimum);
      const next = constrainPaneSizes(currentSizes, nextContainerPx, minimum);
      if (!sizesDiffer(previous, next)) return;
      renderedContainerPxRef.current = nextContainerPx;
      setContainerPx(nextContainerPx);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [direction, sizes, terminalIds.length]);

  const writeSizesToDom = useCallback(
    (nextSizes: readonly number[], extentPx?: number) => {
      const container = containerRef.current;
      if (!container) return;
      const horizontal = direction === "horizontal";
      const boundaries = extentPx && extentPx > 0 ? panePixelBoundaries(nextSizes, extentPx) : null;
      // Terminal canvases paint on whole CSS pixels; fractional tracks make text and borders drift.
      const template = boundaries
        ? [
            ...boundaries.map((boundary, index) => {
              const previousBoundary = boundaries[index - 1] ?? 0;
              return `${boundary - previousBoundary}px`;
            }),
            "minmax(0, 1fr)",
          ].join(" ")
        : paneGridTemplate(nextSizes);
      container.style.gridTemplateColumns = horizontal ? template : "";
      container.style.gridTemplateRows = horizontal ? "" : template;
      const positions = boundaries ?? paneBoundaryOffsets(nextSizes).map((offset) => offset * 100);
      for (const [index, positionValue] of positions.entries()) {
        const handle = handleStateRef.current[index];
        if (!handle) continue;
        const position = boundaries ? `${positionValue}px` : `calc(${positionValue}%)`;
        handle.style.left = horizontal ? position : "";
        handle.style.top = horizontal ? "" : position;
      }
    },
    [direction],
  );

  const resizeHandlers = useResizeDrag<HTMLDivElement>(
    (event) => {
      const dragContainerPx = containerPxRef.current;
      if (dragContainerPx <= 0) return null;
      // React clears currentTarget after dispatch; cleanup runs at drag end.
      const handle = event.currentTarget;
      const handleIndex = Number(handle.dataset.handleIndex);
      const startSizes = displayed;
      const boundaryStartPx = paneBoundaryOffsets(startSizes)[handleIndex]! * dragContainerPx;
      draggingRef.current = true;
      latestSizesRef.current = startSizes;
      handle.dataset.dragging = "true";

      return {
        width: boundaryStartPx,
        axis: direction === "horizontal" ? "x" : "y",
        edge: "right",
        resize(value) {
          const next = resizeAdjacentPanes({
            sizes: startSizes,
            handleIndex,
            deltaPx: value - boundaryStartPx,
            containerPx: dragContainerPx,
            minPanePx: MIN_TERMINAL_PANE_PX[direction],
          });
          const snapped = snapPaneSizesToWholePixels(next, dragContainerPx);
          writeSizesToDom(snapped, dragContainerPx);
          latestSizesRef.current = snapped;
          return panePixelBoundaries(snapped, dragContainerPx)[handleIndex]!;
        },
        finish(_value, moved) {
          const changed = sizesDiffer(startSizes, latestSizesRef.current);
          if (moved && changed) {
            callbacksRef.current.onSizesChange(latestSizesRef.current);
            callbacksRef.current.onResizeEnd();
          } else {
            latestSizesRef.current = startSizes;
            writeSizesToDom(startSizes);
          }
        },
        cleanup() {
          draggingRef.current = false;
          handle.removeAttribute("data-dragging");
        },
      };
    },
    `${direction}:${terminalIds.join(",")}`,
  );

  useLayoutEffect(() => {
    resolvedRef.current = resolved;
    if (draggingRef.current) {
      writeSizesToDom(latestSizesRef.current, containerPxRef.current);
      return;
    }
    latestSizesRef.current = displayed;
    writeSizesToDom(displayed);
  });

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, handleIndex: number) => {
    if (draggingRef.current) return;

    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      callbacksRef.current.onSizesChange(equalPaneSizes(terminalIds.length));
      callbacksRef.current.onResizeEnd();
      return;
    }

    const step = event.shiftKey ? 96 : 24;
    const deltaPx =
      direction === "horizontal"
        ? event.key === "ArrowLeft"
          ? -step
          : event.key === "ArrowRight"
            ? step
            : undefined
        : event.key === "ArrowUp"
          ? -step
          : event.key === "ArrowDown"
            ? step
            : undefined;
    if (deltaPx === undefined) return;

    event.preventDefault();
    event.stopPropagation();
    const next = resizeAdjacentPanes({
      sizes: displayed,
      handleIndex,
      deltaPx,
      containerPx: containerPxRef.current,
      minPanePx: MIN_TERMINAL_PANE_PX[direction],
    });
    const snapped = snapPaneSizesToWholePixels(next, containerPxRef.current);
    callbacksRef.current.onSizesChange(snapped);
    callbacksRef.current.onResizeEnd();
  };

  // Mid-drag re-renders are corrected by the layout effect, which re-applies latestSizesRef.
  const offsets = paneBoundaryOffsets(displayed);
  const gridStyle =
    direction === "horizontal"
      ? { gridTemplateColumns: paneGridTemplate(displayed) }
      : { gridTemplateRows: paneGridTemplate(displayed) };

  return (
    <div
      ref={containerRef}
      className="relative grid h-full w-full min-w-0 gap-0 overflow-hidden"
      style={gridStyle}
    >
      {terminalIds.map((terminalId) => (
        <div
          key={terminalId}
          className={`min-h-0 min-w-0 ${
            direction === "vertical" ? "border-t first:border-t-0" : "border-l first:border-l-0"
          } ${terminalId === activeTerminalId ? "border-border" : "border-border/70"}`}
          onMouseDown={() => {
            if (terminalId !== activeTerminalId) onPaneActivate(terminalId);
          }}
        >
          <div className="h-full">{renderTerminal(terminalId)}</div>
        </div>
      ))}
      {offsets.map((offset: number, handleIndex: number) => (
        <div
          key={`handle-after-${terminalIds[handleIndex]}`}
          ref={(element) => {
            handleStateRef.current[handleIndex] = element;
          }}
          className={`group absolute z-20 select-none touch-none outline-none ${
            direction === "horizontal"
              ? "bottom-0 top-0 w-2 -translate-x-1/2 cursor-col-resize"
              : "left-0 right-0 h-2 -translate-y-1/2 cursor-row-resize"
          }`}
          style={
            direction === "horizontal"
              ? { left: `calc(${offset * 100}%)` }
              : { top: `calc(${offset * 100}%)` }
          }
          role="separator"
          tabIndex={0}
          aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
          aria-label="Resize terminal panes"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(offset * 100)}
          data-handle-index={handleIndex}
          {...resizeHandlers}
          onKeyDown={(event) => handleKeyDown(event, handleIndex)}
          onDoubleClick={() => {
            callbacksRef.current.onSizesChange(equalPaneSizes(terminalIds.length));
            callbacksRef.current.onResizeEnd();
          }}
        >
          <span
            aria-hidden
            className={`pointer-events-none absolute bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-primary/60 group-data-[dragging]:bg-primary/60 ${
              direction === "horizontal"
                ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
                : "inset-x-0 top-1/2 h-px -translate-y-1/2"
            }`}
          />
        </div>
      ))}
    </div>
  );
}
