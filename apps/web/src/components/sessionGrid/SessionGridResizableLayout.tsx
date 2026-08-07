import * as Schema from "effect/Schema";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import {
  equalSessionGridTrackSizes,
  resizeSessionGridTrackBoundary,
  resolveSessionGridTrackSizes,
  sessionGridTrackBoundaryPositions,
  sessionGridTrackTemplate,
  type SessionGridResizeAxis,
} from "./sessionGridResize.logic";

const SESSION_GRID_GAP_PX = 12;
const SESSION_GRID_MIN_COLUMN_PX = 280;
const SESSION_GRID_MIN_ROW_PX = 220;

const PersistedSessionGridLayoutSchema = Schema.Struct({
  columns: Schema.Array(Schema.Finite),
  rows: Schema.Array(Schema.Finite),
});

interface PersistedSessionGridLayout {
  readonly columns: readonly number[];
  readonly rows: readonly number[];
}

interface SessionGridResizableLayoutProps {
  readonly children: ReactNode;
  readonly columns: number;
  readonly rows: number;
  readonly layoutKey: string;
  readonly resizable: boolean;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

interface ResizeState {
  readonly axis: SessionGridResizeAxis;
  readonly boundaryIndex: number;
  readonly pointerId: number;
  readonly startPosition: number;
  readonly startSizes: readonly number[];
  readonly availableSize: number;
  readonly target: HTMLDivElement;
  readonly previousCursor: string;
  readonly previousUserSelect: string;
  pendingSizes: readonly number[];
  animationFrameId: number | null;
}

function sessionGridLayoutStorageKey(layoutKey: string, columns: number, rows: number) {
  return `t3code:session-grid-layout:${encodeURIComponent(layoutKey)}:${columns}x${rows}`;
}

function initialLayout(
  storageKey: string,
  columns: number,
  rows: number,
): PersistedSessionGridLayout {
  try {
    const stored = getLocalStorageItem(storageKey, PersistedSessionGridLayoutSchema);
    return {
      columns: resolveSessionGridTrackSizes(stored?.columns, columns),
      rows: resolveSessionGridTrackSizes(stored?.rows, rows),
    };
  } catch (error) {
    console.error("Could not read the persisted session grid layout.", error);
    return {
      columns: equalSessionGridTrackSizes(columns),
      rows: equalSessionGridTrackSizes(rows),
    };
  }
}

function persistLayout(storageKey: string, layout: PersistedSessionGridLayout) {
  try {
    setLocalStorageItem(storageKey, layout, PersistedSessionGridLayoutSchema);
  } catch (error) {
    console.error("Could not persist the session grid layout.", error);
  }
}

function TrackResizeHandle(props: {
  readonly axis: SessionGridResizeAxis;
  readonly active: boolean;
  readonly boundaryIndex: number;
  readonly position: {
    readonly boundaryKey: string;
    readonly percentage: number;
    readonly offsetPx: number;
  };
  readonly onDoubleClick: (axis: SessionGridResizeAxis) => void;
  readonly onKeyDown: (
    axis: SessionGridResizeAxis,
    boundaryIndex: number,
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => void;
  readonly onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerDown: (
    axis: SessionGridResizeAxis,
    boundaryIndex: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const vertical = props.axis === "columns";
  const style: CSSProperties = vertical
    ? {
        left: `calc(${props.position.percentage}% + ${props.position.offsetPx}px)`,
      }
    : {
        top: `calc(${props.position.percentage}% + ${props.position.offsetPx}px)`,
      };
  const firstTrack = props.boundaryIndex + 1;
  const secondTrack = firstTrack + 1;
  const label = vertical
    ? `Resize session grid columns ${firstTrack} and ${secondTrack}`
    : `Resize session grid rows ${firstTrack} and ${secondTrack}`;

  return (
    <div
      aria-label={`${label}. Use arrow keys to resize.`}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round(props.position.percentage)}
      className={cn(
        "group absolute z-30 touch-none select-none outline-none",
        vertical
          ? "inset-y-0 w-3 -translate-x-1/2 cursor-col-resize"
          : "inset-x-0 h-3 -translate-y-1/2 cursor-row-resize",
      )}
      data-active={props.active ? "true" : undefined}
      data-session-grid-resize-handle={vertical ? "column" : "row"}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onDoubleClick(props.axis);
      }}
      onKeyDown={(event) => props.onKeyDown(props.axis, props.boundaryIndex, event)}
      onLostPointerCapture={props.onLostPointerCapture}
      onPointerCancel={props.onPointerCancel}
      onPointerDown={(event) => props.onPointerDown(props.axis, props.boundaryIndex, event)}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      role="separator"
      style={style}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute rounded-full bg-transparent transition-[background-color,box-shadow] duration-150",
          "group-hover:bg-border group-focus-visible:bg-ring/80 group-data-[active=true]:bg-ring/80 group-data-[active=true]:shadow-[0_0_6px_color-mix(in_srgb,var(--ring)_30%,transparent)]",
          vertical
            ? "inset-y-1 left-1/2 w-px -translate-x-1/2"
            : "inset-x-1 top-1/2 h-px -translate-y-1/2",
        )}
      />
    </div>
  );
}

// fork: project session grid — flexible tracks mirror 2code's shared-edge
// resizing while keeping persistence and pointer work isolated from ChatView.
export function SessionGridResizableLayout(props: SessionGridResizableLayoutProps) {
  const storageKey = sessionGridLayoutStorageKey(props.layoutKey, props.columns, props.rows);
  const [layout, setLayout] = useState(() => initialLayout(storageKey, props.columns, props.rows));
  const [activeHandle, setActiveHandle] = useState<{
    readonly axis: SessionGridResizeAxis;
    readonly boundaryIndex: number;
  } | null>(null);
  const layoutRef = useRef(layout);
  const gridRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<ResizeState | null>(null);

  const replaceLayout = useCallback((next: PersistedSessionGridLayout) => {
    layoutRef.current = next;
    setLayout(next);
    return next;
  }, []);
  const replaceAxisSizes = useCallback(
    (axis: SessionGridResizeAxis, sizes: readonly number[]) =>
      replaceLayout({ ...layoutRef.current, [axis]: [...sizes] }),
    [replaceLayout],
  );

  useEffect(() => {
    const next = initialLayout(storageKey, props.columns, props.rows);
    replaceLayout(next);
  }, [props.columns, props.rows, replaceLayout, storageKey]);

  const clearResizeState = useCallback((state: ResizeState) => {
    if (state.animationFrameId !== null) {
      window.cancelAnimationFrame(state.animationFrameId);
    }
    resizeRef.current = null;
    try {
      if (state.target.hasPointerCapture(state.pointerId)) {
        state.target.releasePointerCapture(state.pointerId);
      }
    } catch {
      // Pointer capture can already be released after a window-level cancel.
    }
    document.body.style.cursor = state.previousCursor;
    document.body.style.userSelect = state.previousUserSelect;
    setActiveHandle(null);
  }, []);

  useEffect(
    () => () => {
      const state = resizeRef.current;
      if (!state) return;
      if (state.animationFrameId !== null) {
        window.cancelAnimationFrame(state.animationFrameId);
      }
      document.body.style.cursor = state.previousCursor;
      document.body.style.userSelect = state.previousUserSelect;
      resizeRef.current = null;
    },
    [],
  );

  const finishActiveResize = useCallback(
    (commit: boolean) => {
      const state = resizeRef.current;
      if (!state) return;
      const next = commit
        ? replaceAxisSizes(state.axis, state.pendingSizes)
        : replaceAxisSizes(state.axis, state.startSizes);
      clearResizeState(state);
      if (commit) {
        persistLayout(storageKey, next);
        window.dispatchEvent(new Event("resize"));
      }
    },
    [clearResizeState, replaceAxisSizes, storageKey],
  );
  const finishResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
      if (resizeRef.current?.pointerId !== event.pointerId) return;
      finishActiveResize(commit);
    },
    [finishActiveResize],
  );

  useEffect(() => {
    if (!activeHandle) return;
    const handleWindowBlur = () => finishActiveResize(true);
    window.addEventListener("blur", handleWindowBlur);
    return () => window.removeEventListener("blur", handleWindowBlur);
  }, [activeHandle, finishActiveResize]);

  const handlePointerDown = useCallback(
    (
      axis: SessionGridResizeAxis,
      boundaryIndex: number,
      event: ReactPointerEvent<HTMLDivElement>,
    ) => {
      if (event.button !== 0 || !props.resizable) return;
      const grid = gridRef.current;
      if (!grid) return;
      const sizes = layoutRef.current[axis];
      const rect = grid.getBoundingClientRect();
      const totalGap = SESSION_GRID_GAP_PX * Math.max(0, sizes.length - 1);
      const availableSize = (axis === "columns" ? rect.width : rect.height) - totalGap;
      if (availableSize <= 0) return;

      event.preventDefault();
      event.stopPropagation();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        return;
      }
      const cursor = axis === "columns" ? "col-resize" : "row-resize";
      resizeRef.current = {
        axis,
        boundaryIndex,
        pointerId: event.pointerId,
        startPosition: axis === "columns" ? event.clientX : event.clientY,
        startSizes: [...sizes],
        availableSize,
        target: event.currentTarget,
        previousCursor: document.body.style.cursor,
        previousUserSelect: document.body.style.userSelect,
        pendingSizes: [...sizes],
        animationFrameId: null,
      };
      document.body.style.cursor = cursor;
      document.body.style.userSelect = "none";
      setActiveHandle({ axis, boundaryIndex });
    },
    [props.resizable],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = resizeRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      event.preventDefault();
      const position = state.axis === "columns" ? event.clientX : event.clientY;
      state.pendingSizes = resizeSessionGridTrackBoundary({
        sizes: state.startSizes,
        boundaryIndex: state.boundaryIndex,
        deltaPx: position - state.startPosition,
        availableSizePx: state.availableSize,
        minimumTrackSizePx:
          state.axis === "columns" ? SESSION_GRID_MIN_COLUMN_PX : SESSION_GRID_MIN_ROW_PX,
      });
      if (state.animationFrameId !== null) return;
      state.animationFrameId = window.requestAnimationFrame(() => {
        const active = resizeRef.current;
        if (!active) return;
        active.animationFrameId = null;
        replaceAxisSizes(active.axis, active.pendingSizes);
      });
    },
    [replaceAxisSizes],
  );

  const handleKeyDown = useCallback(
    (
      axis: SessionGridResizeAxis,
      boundaryIndex: number,
      event: ReactKeyboardEvent<HTMLDivElement>,
    ) => {
      const direction =
        axis === "columns"
          ? event.key === "ArrowLeft"
            ? -1
            : event.key === "ArrowRight"
              ? 1
              : 0
          : event.key === "ArrowUp"
            ? -1
            : event.key === "ArrowDown"
              ? 1
              : 0;
      if (direction === 0) return;
      const grid = gridRef.current;
      if (!grid) return;
      event.preventDefault();
      event.stopPropagation();
      const sizes = layoutRef.current[axis];
      const rect = grid.getBoundingClientRect();
      const availableSize =
        (axis === "columns" ? rect.width : rect.height) -
        SESSION_GRID_GAP_PX * Math.max(0, sizes.length - 1);
      const nextSizes = resizeSessionGridTrackBoundary({
        sizes,
        boundaryIndex,
        deltaPx: direction * (event.shiftKey ? 48 : 16),
        availableSizePx: availableSize,
        minimumTrackSizePx:
          axis === "columns" ? SESSION_GRID_MIN_COLUMN_PX : SESSION_GRID_MIN_ROW_PX,
      });
      const next = replaceAxisSizes(axis, nextSizes);
      persistLayout(storageKey, next);
      window.dispatchEvent(new Event("resize"));
    },
    [replaceAxisSizes, storageKey],
  );

  const resetAxis = useCallback(
    (axis: SessionGridResizeAxis) => {
      const count = axis === "columns" ? props.columns : props.rows;
      const next = replaceAxisSizes(axis, equalSessionGridTrackSizes(count));
      persistLayout(storageKey, next);
      window.dispatchEvent(new Event("resize"));
    },
    [props.columns, props.rows, replaceAxisSizes, storageKey],
  );

  const columnPositions = sessionGridTrackBoundaryPositions({
    sizes: layout.columns,
    gapPx: SESSION_GRID_GAP_PX,
  });
  const rowPositions = sessionGridTrackBoundaryPositions({
    sizes: layout.rows,
    gapPx: SESSION_GRID_GAP_PX,
  });
  const gridStyle: CSSProperties = props.resizable
    ? {
        gridTemplateColumns: sessionGridTrackTemplate(layout.columns),
        gridTemplateRows: sessionGridTrackTemplate(layout.rows),
      }
    : {
        gridTemplateColumns: "minmax(0, 1fr)",
        gridAutoRows: "minmax(30rem, calc(100svh - 8rem))",
      };

  return (
    <div
      className={cn(
        "h-full min-h-0 min-w-0 bg-zinc-900 p-3 dark:bg-black",
        !props.resizable && "overflow-y-auto overscroll-y-contain",
      )}
    >
      <div className="relative h-full min-h-0 min-w-0" ref={gridRef}>
        <div
          className="grid h-full min-h-0 min-w-0 gap-3"
          data-session-grid-columns={props.resizable ? props.columns : 1}
          data-session-grid-resizable={props.resizable ? "true" : "false"}
          onKeyDown={props.onKeyDown}
          style={gridStyle}
        >
          {props.children}
        </div>
        {props.resizable
          ? columnPositions.map((position, boundaryIndex) => (
              <TrackResizeHandle
                active={
                  activeHandle?.axis === "columns" && activeHandle.boundaryIndex === boundaryIndex
                }
                axis="columns"
                boundaryIndex={boundaryIndex}
                key={`column:${position.boundaryKey}`}
                onDoubleClick={resetAxis}
                onKeyDown={handleKeyDown}
                onLostPointerCapture={(event) => finishResize(event, true)}
                onPointerCancel={(event) => finishResize(event, false)}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={(event) => finishResize(event, true)}
                position={position}
              />
            ))
          : null}
        {props.resizable
          ? rowPositions.map((position, boundaryIndex) => (
              <TrackResizeHandle
                active={
                  activeHandle?.axis === "rows" && activeHandle.boundaryIndex === boundaryIndex
                }
                axis="rows"
                boundaryIndex={boundaryIndex}
                key={`row:${position.boundaryKey}`}
                onDoubleClick={resetAxis}
                onKeyDown={handleKeyDown}
                onLostPointerCapture={(event) => finishResize(event, true)}
                onPointerCancel={(event) => finishResize(event, false)}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={(event) => finishResize(event, true)}
                position={position}
              />
            ))
          : null}
      </div>
    </div>
  );
}
