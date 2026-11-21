/* oxlint-disable react/no-array-index-key -- Positions identify source rows and columns. */
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { observeResize } from "~/lib/observeResize";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { PREVIEW_PAGE_ROWS } from "./largeTextProtocol";

export default function VirtualTablePreview(props: {
  readonly name: string;
  readonly count: number;
  readonly columns: number;
  readonly getRows: (page: number) => readonly (readonly string[])[] | undefined;
  readonly loadPage?: (page: number) => void;
  readonly header?: readonly string[] | undefined;
  readonly source?: boolean;
  readonly wrap?: boolean;
  readonly revealLine?: number | null;
  readonly revealRequestId?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 600 });
  const { width } = size;
  const widthRef = useRef(0);
  const measureRef = useRef<HTMLTableElement>(null);
  const [measured, setMeasured] = useState<number[] | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Measure the viewport before paint and observe container resizes to invalidate column measurements.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      setSize((old) => (old.width === width && old.height === height ? old : { width, height }));
      if (widthRef.current !== width) {
        widthRef.current = width;
        setMeasured(null);
      }
    };
    update();
    return observeResize(node, update);
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read the browser's laid-out table column widths before displaying the virtual table.
  useLayoutEffect(() => {
    if (!width || !props.header || !measureRef.current || measured) return;
    const widths = [...measureRef.current.querySelectorAll("thead th")].map(
      (cell) => cell.getBoundingClientRect().width,
    );
    if (widths.length) setMeasured(widths);
  }, [measured, width, props.header]);
  const columnWidth = props.source
    ? 0
    : Math.max(128, Math.min(320, (width - 56) / Math.min(props.columns, 6)));
  const rowHeader = 56;
  const sizes = Array.from(
    { length: props.columns },
    (_, column) => measured?.[column] ?? columnWidth,
  );
  const offsets = [0];
  for (const size of sizes) offsets.push(offsets[offsets.length - 1]! + size);
  const firstColumn = props.source
    ? 0
    : Math.max(0, sizes.findIndex((_, column) => offsets[column + 1]! > left - rowHeader) - 1);
  const lastColumn = props.source
    ? 1
    : Math.min(
        props.columns,
        offsets.findIndex((offset) => offset >= left + width - rowHeader) + 1 || props.columns,
      );
  const columns = Array.from(
    { length: Math.max(0, lastColumn - firstColumn) },
    (_, i) => firstColumn + i,
  );
  const offset = (column: number) => offsets[column]!;
  const tableWidth = props.source ? "100%" : Math.max(width, offset(props.columns) + rowHeader);
  const hasHorizontalOverflow = !props.source && offset(props.columns) + rowHeader > width;
  return (
    <div
      ref={ref}
      className="relative min-h-0 flex-1 overflow-x-auto contain-strict"
      onScroll={(event) => {
        event.currentTarget.style.setProperty(
          "--preview-scroll-left",
          `${event.currentTarget.scrollLeft}px`,
        );
        setLeft(event.currentTarget.scrollLeft);
      }}
    >
      {props.header && props.columns <= 30 && !measured && width > 0 ? (
        <table
          ref={measureRef}
          aria-hidden="true"
          className="invisible absolute top-0 border-separate border-spacing-0 text-xs"
          style={{ width: Math.max(width - rowHeader, props.columns * 128) }}
        >
          <thead>
            <tr>
              {props.header.map((cell, i) => (
                <th
                  key={i}
                  className="min-w-32 max-w-80 border-b px-3 py-1.5 text-left font-medium whitespace-nowrap"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props
              .getRows(0)
              ?.slice(1, 20)
              .map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className="max-w-80 border-b px-3 py-1.5 whitespace-pre-wrap break-words tabular-nums"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      ) : null}
      {width > 0 && (!props.header || props.columns > 30 || measured) ? (
        <div
          role={props.source ? "region" : "table"}
          aria-label={props.name}
          aria-rowcount={props.count}
          aria-colcount={props.source ? undefined : props.columns}
          className="flex h-full min-h-0 flex-col text-xs"
          style={{ width: tableWidth }}
        >
          {!props.source ? (
            <div
              role="row"
              className="relative z-10 flex min-h-[29px] shrink-0 border-b border-border bg-muted/60 font-medium backdrop-blur"
            >
              <div className="sticky left-0 z-10 w-14 shrink-0 border-r border-border bg-background" />
              <div style={{ width: offset(firstColumn), flexShrink: 0 }} />
              {columns.map((column) => (
                <Tooltip key={column}>
                  <TooltipTrigger
                    render={
                      <div
                        role="columnheader"
                        aria-colindex={column + 1}
                        className="shrink-0 overflow-hidden border-r border-border/40 px-3 py-1.5 text-ellipsis whitespace-pre"
                        style={{ width: sizes[column] }}
                      >
                        {props.header?.[column] ?? columnLabel(column)}
                      </div>
                    }
                  />
                  <TooltipPopup>{props.header?.[column] ?? columnLabel(column)}</TooltipPopup>
                </Tooltip>
              ))}
            </div>
          ) : null}
          <ScaledRows
            {...props}
            columnsVisible={columns}
            sizes={sizes}
            hasHorizontalOverflow={hasHorizontalOverflow}
            rowHeader={rowHeader}
            firstColumn={firstColumn}
            viewportHeight={size.height - (props.source ? 0 : 29)}
          />
        </div>
      ) : null}
    </div>
  );
}
function RowPage(
  props: Parameters<typeof VirtualTablePreview>[0] & {
    page: number;
    columnsVisible: number[];
    sizes: number[];
    rowHeights?: ReadonlyMap<readonly string[], number> | undefined;
    rowHeader: number;
    firstColumn: number;
    viewportHeight: number;
    limit?: number;
  },
) {
  const rows = props.getRows(props.page);
  // A page stays mounted while the worker fills it, preserving the scroll position.
  const { loadPage, page } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Request this page's rows from the indexing worker when they are missing or incomplete.
  useEffect(() => {
    const expected = Math.min(PREVIEW_PAGE_ROWS, props.count - page * PREVIEW_PAGE_ROWS);
    if (!rows || rows.length < expected) loadPage?.(page);
  }, [rows, page, loadPage, props.count]);
  const start = props.page * PREVIEW_PAGE_ROWS;
  const count = Math.min(PREVIEW_PAGE_ROWS, props.count - start, props.limit ?? PREVIEW_PAGE_ROWS);
  return (
    <div role="rowgroup">
      {Array.from({ length: count }, (_, local) => {
        const row = rows?.[local];
        const index = start + local;
        if (props.header && index === 0) return null;
        const rowMinHeight = !props.source && row ? props.rowHeights?.get(row) : undefined;
        return (
          <div
            key={local}
            data-preview-row={index}
            role={props.source ? undefined : "row"}
            aria-rowindex={props.source ? undefined : index + 1}
            className={
              props.source
                ? `flex min-h-[29px] font-mono ${props.revealLine != null && Math.min(props.count, Math.max(1, props.revealLine)) === index + 1 ? "bg-primary/10" : ""}`
                : `flex min-h-[29px] border-b border-border/60 ${(index - (props.header ? 1 : 0)) % 2 ? "bg-muted/30" : ""}`
            }
            style={rowMinHeight ? { minHeight: rowMinHeight } : undefined}
            data-preview-reveal={
              props.revealLine != null &&
              Math.min(props.count, Math.max(1, props.revealLine)) === index + 1
                ? "true"
                : undefined
            }
          >
            <div
              role={props.source ? undefined : "rowheader"}
              className={`${props.source ? "sticky left-0" : "relative"} z-1 shrink-0 border-r border-border bg-background px-2 py-1.5 text-right font-normal text-muted-foreground tabular-nums select-none`}
              style={{
                width: props.rowHeader,
                transform: props.source ? undefined : "translateX(var(--preview-scroll-left, 0px))",
              }}
            >
              <span className="sticky top-0 block">{index + (props.header ? 0 : 1)}</span>
            </div>
            {!props.source ? (
              <div
                style={{
                  width: props.sizes.slice(0, props.firstColumn).reduce((a, b) => a + b, 0),
                  flexShrink: 0,
                }}
              />
            ) : null}
            {props.columnsVisible.map((column) => (
              <div
                key={column}
                role={props.source ? undefined : "cell"}
                aria-colindex={props.source ? undefined : column + 1}
                className={
                  props.source
                    ? `min-w-0 flex-1 px-3 py-1 ${props.wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`
                    : "shrink-0 border-r border-border/40 px-3 py-1.5 whitespace-pre-wrap break-words tabular-nums"
                }
                style={props.source ? undefined : { width: props.sizes[column] }}
              >
                {row?.[column] ?? ""}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function ScaledRows(
  props: Omit<Parameters<typeof RowPage>[0], "page" | "rowHeights"> & {
    hasHorizontalOverflow: boolean;
  },
) {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const rowProbeRef = useRef<HTMLDivElement>(null);
  const rowHeightCacheRef = useRef<{
    key: string;
    heights: WeakMap<readonly string[], number>;
  }>({ key: "", heights: new WeakMap() });
  const [rowHeights, setRowHeights] = useState<{
    key: string;
    heights: ReadonlyMap<readonly string[], number>;
  }>({ key: "", heights: new Map() });
  const [layout, setLayout] = useState({ offset: 0, height: 0, rowHeight: 29 });
  const [top, setTop] = useState(0);
  const handledReveal = useRef<string | null>(null);
  const pendingReveal = useRef<{ row: number; attempts: number } | null>(null);
  const pendingEnd = useRef(false);
  const position = { top, height: props.viewportHeight };
  const scrollHeight = Math.min(8_000_000, props.count * 29);
  // Chromium caps a scroll surface at 33 million pixels. Scale the track for
  // multi-million-line logs while retaining real row heights in the viewport.
  const headerRows = props.header ? 1 : 0;
  const maxFirst = Math.max(0, props.count - headerRows - Math.floor(position.height / 29));
  const scale = Math.max(1, scrollHeight - position.height) / Math.max(1, maxFirst * 29);
  const first = Math.min(maxFirst, Math.floor(position.top / scale / 29)) + headerRows;
  // The final mounted rows keep their measured height and scroll natively.
  const nativeTail = first - headerRows === maxFirst;
  const scrollModel = useRef({ scale, maxFirst, heights: [] as number[] });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Measure native tail rows and preserve the DOM scroll position when the virtual track scale changes.
  useLayoutEffect(() => {
    const previous = scrollModel.current;
    const heights = nativeTail
      ? Array.from(contentRef.current?.querySelectorAll<HTMLElement>("[data-preview-row]") ?? [])
          .filter((row) => Number(row.dataset.previewRow) >= first)
          .map((row) => row.offsetHeight)
      : [];
    scrollModel.current = { scale, maxFirst, heights };
    const node = ref.current;
    if (!node || (previous.scale === scale && previous.maxFirst === maxFirst)) return;
    const previousEnd = previous.maxFirst * 29 * previous.scale;
    let logicalTop = Math.min(previous.maxFirst * 29, node.scrollTop / previous.scale);
    let remaining = Math.max(0, node.scrollTop - previousEnd);
    // Native-tail pixels cross rows of different heights before returning to the scaled track.
    for (const height of previous.heights) {
      logicalTop += Math.min(1, remaining / height) * 29;
      remaining = Math.max(0, remaining - height);
      if (!remaining) break;
    }
    let nativeOffset = 0;
    remaining = Math.max(0, logicalTop / 29 - maxFirst);
    for (const height of heights) {
      nativeOffset += Math.min(1, remaining) * height;
      remaining = Math.max(0, remaining - 1);
      if (!remaining) break;
    }
    node.scrollTop = Math.min(maxFirst * 29, logicalTop) * scale + nativeOffset;
    setTop(node.scrollTop);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Scroll the DOM viewport to a requested line after its virtual track has committed.
  useLayoutEffect(() => {
    const node = ref.current;
    if (props.revealLine == null) {
      handledReveal.current = null;
      pendingReveal.current = null;
      return;
    }
    const key = `${props.revealRequestId}:${props.revealLine}`;
    if (!node || !props.count || handledReveal.current === key) return;
    const row = Math.min(props.count, Math.max(1, props.revealLine)) - 1;
    node.scrollTop = Math.max(0, (row - headerRows) * 29) * scale;
    setTop(node.scrollTop);
    pendingEnd.current = false;
    pendingReveal.current = { row, attempts: 0 };
    handledReveal.current = key;
  }, [props.revealLine, props.revealRequestId, props.count, headerRows, scale]);
  const atStart = position.top === 0;
  const rowHeight = () =>
    contentRef.current?.querySelector<HTMLElement>(`[data-preview-row="${first}"]`)?.offsetHeight ||
    29;
  const onWheel = useEffectEvent((event: WheelEvent) => {
    const node = ref.current;
    if (!node || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const delta =
      event.deltaY * (event.deltaMode === 1 ? 29 : event.deltaMode === 2 ? node.clientHeight : 1);
    if (!delta) return;
    event.preventDefault();
    pendingEnd.current = false;
    node.scrollTop += delta * (nativeTail ? 1 : (scale * 29) / rowHeight());
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Install a non-passive native wheel listener so virtual scrolling can prevent the browser's default scroll.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => onWheel(event);
    node.addEventListener("wheel", wheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", wheel);
    };
  }, []);
  const page = Math.floor(first / PREVIEW_PAGE_ROWS);
  const visibleEnd = (first % PREVIEW_PAGE_ROWS) + Math.ceil(position.height / 29) + 1;
  const sizesKey = props.sizes.join(",");
  const pageCount = Math.min(
    Math.ceil(visibleEnd / PREVIEW_PAGE_ROWS),
    Math.ceil(props.count / PREVIEW_PAGE_ROWS) - page,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Measure mounted rows across all columns before paint so horizontal column virtualization keeps row heights and vertical scroll position stable.
  useLayoutEffect(() => {
    const probe = rowProbeRef.current;
    if (!props.hasHorizontalOverflow || !probe) return;
    if (rowHeightCacheRef.current.key !== sizesKey) {
      rowHeightCacheRef.current = { key: sizesKey, heights: new WeakMap() };
    }
    const cache = rowHeightCacheRef.current.heights;
    const mounted: (readonly string[])[] = [];
    const uncached = new Set<readonly string[]>();
    for (let pageOffset = 0; pageOffset < pageCount; pageOffset++) {
      const currentPage = page + pageOffset;
      const rows = props.getRows(currentPage);
      if (!rows) continue;
      const start = currentPage * PREVIEW_PAGE_ROWS;
      const limit = visibleEnd - pageOffset * PREVIEW_PAGE_ROWS;
      const count = Math.min(PREVIEW_PAGE_ROWS, props.count - start, limit);
      for (let local = 0; local < count; local++) {
        if (props.header && start + local === 0) continue;
        const row = rows[local];
        if (!row) continue;
        mounted.push(row);
        if (!cache.has(row)) uncached.add(row);
      }
    }
    if (uncached.size > 0) {
      const measuredHeights = measureRowsFullHeight(
        probe,
        [...uncached],
        props.columns,
        props.sizes,
      );
      for (const [row, height] of measuredHeights) cache.set(row, height);
    }
    const next = new Map<readonly string[], number>();
    for (const row of mounted) {
      const height = cache.get(row);
      if (height && height > BASE_ROW_HEIGHT) next.set(row, height);
    }
    setRowHeights((old) =>
      old.key === sizesKey && sameRowHeightMap(old.heights, next)
        ? old
        : { key: sizesKey, heights: next },
    );
  });
  const activeRowHeights =
    props.hasHorizontalOverflow && rowHeights.key === sizesKey ? rowHeights.heights : undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Measure mounted row offsets and observe content resizes to position the virtual rows against the scroll track.
  useLayoutEffect(() => {
    if (atStart) return;
    const node = contentRef.current;
    if (!node) return;
    const update = () => {
      const row = node.querySelector<HTMLElement>(`[data-preview-row="${first}"]`);
      const offset = row ? row.getBoundingClientRect().top - node.getBoundingClientRect().top : 0;
      const height = node.clientHeight;
      const rowHeight = row?.offsetHeight || 29;
      setLayout((old) =>
        old.offset === offset && old.height === height && old.rowHeight === rowHeight
          ? old
          : { offset, height, rowHeight },
      );
    };
    update();
    return observeResize(node, update);
  }, [first, atStart]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Correct the DOM scroll position once a requested worker row has loaded and its actual bounds are measurable.
  useLayoutEffect(() => {
    const pending = pendingReveal.current;
    const node = ref.current;
    const row =
      pending &&
      contentRef.current?.querySelector<HTMLElement>(`[data-preview-row="${pending.row}"]`);
    if (
      !pending ||
      !node ||
      !row ||
      !props.getRows(Math.floor(pending.row / PREVIEW_PAGE_ROWS))?.[pending.row % PREVIEW_PAGE_ROWS]
    )
      return;
    const content = contentRef.current!;
    const firstRow = content.querySelector<HTMLElement>(`[data-preview-row="${first}"]`);
    if (
      !atStart &&
      (layout.height !== content.clientHeight ||
        layout.offset !==
          (firstRow
            ? firstRow.getBoundingClientRect().top - content.getBoundingClientRect().top
            : 0))
    )
      return;
    const bounds = row.getBoundingClientRect();
    const viewport = node.getBoundingClientRect();
    const delta =
      bounds.top < viewport.top
        ? bounds.top - viewport.top
        : Math.min(bounds.bottom, bounds.top + viewport.height) > viewport.bottom
          ? Math.min(bounds.bottom, bounds.top + viewport.height) - viewport.bottom
          : 0;
    if (Math.abs(delta) < 1 || pending.attempts++ >= 8) {
      pendingReveal.current = null;
      return;
    }
    node.scrollTop += delta * (nativeTail ? 1 : (scale * 29) / Math.max(29, bounds.height));
    setTop(node.scrollTop);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Complete End-key scrolling after the final worker row has loaded and its DOM layout has settled.
  useLayoutEffect(() => {
    const node = ref.current;
    const content = contentRef.current;
    if (!pendingEnd.current || !nativeTail || !node || !content || !props.count) return;
    const last = props.count - 1;
    if (!props.getRows(Math.floor(last / PREVIEW_PAGE_ROWS))?.[last % PREVIEW_PAGE_ROWS]) return;
    const row = content.querySelector<HTMLElement>(`[data-preview-row="${last}"]`);
    const firstRow = content.querySelector<HTMLElement>(`[data-preview-row="${first}"]`);
    if (
      !row ||
      (!atStart &&
        (layout.height !== content.clientHeight ||
          layout.offset !==
            (firstRow
              ? firstRow.getBoundingClientRect().top - content.getBoundingClientRect().top
              : 0)))
    )
      return;
    node.scrollTop = node.scrollHeight;
    setTop(node.scrollTop);
    if (Math.abs(row.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom) < 1)
      pendingEnd.current = false;
  });
  return (
    <div
      ref={ref}
      tabIndex={0}
      className="min-h-0 flex-1 overflow-auto"
      onKeyDown={(event) => {
        const node = event.currentTarget;
        const delta =
          event.key === "ArrowDown"
            ? 29
            : event.key === "ArrowUp"
              ? -29
              : event.key === "PageDown"
                ? node.clientHeight
                : event.key === "PageUp"
                  ? -node.clientHeight
                  : null;
        if (delta !== null) {
          pendingEnd.current = false;
          event.preventDefault();
          node.scrollTop += delta * (nativeTail ? 1 : (scale * 29) / rowHeight());
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          pendingEnd.current = event.key === "End";
          pendingReveal.current = null;
          node.scrollTop = event.key === "Home" ? 0 : node.scrollHeight;
          setTop(node.scrollTop);
        }
      }}
      onScroll={(event) => setTop(event.currentTarget.scrollTop)}
    >
      <div className="relative" style={{ height: scrollHeight }}>
        {!props.source ? (
          <div
            ref={rowProbeRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute top-0 left-0 h-0 w-0 overflow-hidden"
          />
        ) : null}
        <div
          ref={contentRef}
          className="absolute inset-x-0"
          style={{
            top:
              maxFirst === 0
                ? 0
                : nativeTail
                  ? maxFirst * scale * 29 - layout.offset
                  : position.top +
                    (atStart
                      ? 0
                      : -layout.offset - ((position.top / scale / 29) % 1) * layout.rowHeight),
          }}
        >
          {Array.from({ length: pageCount }, (_, offset) => (
            <RowPage
              key={page + offset}
              {...props}
              page={page + offset}
              rowHeights={activeRowHeights}
              limit={visibleEnd - offset * PREVIEW_PAGE_ROWS}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const BASE_ROW_HEIGHT = 29;
const CELL_HORIZONTAL_INSET = 25;
const MAX_MEASURED_CELLS_PER_ROW = 16;
const PROBE_CELL_CLASS_NAME =
  "box-border border-r border-b border-transparent px-3 py-1.5 whitespace-pre-wrap break-words tabular-nums";

let textMeasureContext: CanvasRenderingContext2D | null | undefined;

function getTextMeasureContext(probe: HTMLElement): CanvasRenderingContext2D | null {
  if (textMeasureContext === undefined) {
    textMeasureContext = document.createElement("canvas").getContext("2d");
  }
  if (textMeasureContext) {
    textMeasureContext.font = getComputedStyle(probe).font;
  }
  return textMeasureContext;
}

function estimateWrappedLines(
  text: string,
  innerWidth: number,
  ctx: CanvasRenderingContext2D | null,
  fontSize: number,
): number {
  let lines = 0;
  let start = 0;
  while (start <= text.length) {
    const next = text.indexOf("\n", start);
    const end = next === -1 ? text.length : next;
    const lineEnd = end > start && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    const segment = text.slice(start, lineEnd);
    if (segment.length === 0) {
      lines += 1;
    } else {
      const width = ctx ? ctx.measureText(segment).width : segment.length * (fontSize * 0.65);
      lines += Math.max(1, Math.ceil(width / innerWidth));
    }
    if (next === -1) break;
    start = next + 1;
  }
  return lines;
}

function selectRowHeightCandidates(
  row: readonly string[],
  columns: number,
  sizes: readonly number[],
  ctx: CanvasRenderingContext2D | null,
  fontSize: number,
): Array<{ column: number; text: string }> {
  const candidates: Array<{ column: number; text: string; score: number }> = [];
  const limit = Math.min(columns, row.length);
  const maxGlyphWidth = fontSize * 1.5;
  for (let column = 0; column < limit; column++) {
    const text = row[column];
    if (!text) continue;
    const width = sizes[column];
    if (!width) continue;
    const innerWidth = Math.max(1, width - CELL_HORIZONTAL_INSET);
    const hasControlWhitespace = text.includes("\n") || text.includes("\r") || text.includes("\t");
    if (!hasControlWhitespace && text.length * maxGlyphWidth <= innerWidth) continue;
    if (
      !hasControlWhitespace &&
      ctx &&
      ctx.measureText(text.replace(/\d/g, "0")).width <= innerWidth - 8
    ) {
      continue;
    }
    candidates.push({
      column,
      text,
      score: estimateWrappedLines(text, innerWidth, ctx, fontSize),
    });
  }
  if (candidates.length > MAX_MEASURED_CELLS_PER_ROW) {
    candidates.sort((left, right) => right.score - left.score);
    candidates.length = MAX_MEASURED_CELLS_PER_ROW;
  }
  return candidates;
}

function measureRowsFullHeight(
  probe: HTMLElement,
  rows: readonly (readonly string[])[],
  columns: number,
  sizes: readonly number[],
): Map<readonly string[], number> {
  const results = new Map<readonly string[], number>();
  const fontSize = Number.parseFloat(getComputedStyle(probe).fontSize) || 12;
  const ctx = getTextMeasureContext(probe);
  const fragment = document.createDocumentFragment();
  const entries: Array<{ row: readonly string[]; node: HTMLDivElement }> = [];
  for (const row of rows) {
    const candidates = selectRowHeightCandidates(row, columns, sizes, ctx, fontSize);
    results.set(row, BASE_ROW_HEIGHT);
    for (const candidate of candidates) {
      const node = document.createElement("div");
      node.className = PROBE_CELL_CLASS_NAME;
      node.style.width = `${sizes[candidate.column]}px`;
      node.textContent = candidate.text;
      fragment.append(node);
      entries.push({ row, node });
    }
  }
  if (entries.length > 0) {
    probe.replaceChildren(fragment);
    for (const entry of entries) {
      const height = entry.node.getBoundingClientRect().height;
      const current = results.get(entry.row) ?? BASE_ROW_HEIGHT;
      if (height > current) results.set(entry.row, height);
    }
    probe.replaceChildren();
  }
  return results;
}

function sameRowHeightMap(
  left: ReadonlyMap<readonly string[], number>,
  right: ReadonlyMap<readonly string[], number>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [row, height] of left) {
    if (right.get(row) !== height) return false;
  }
  return true;
}

function columnLabel(index: number): string {
  let label = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  return label;
}
