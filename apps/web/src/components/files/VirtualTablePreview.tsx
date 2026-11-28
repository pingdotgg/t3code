/* oxlint-disable react/no-array-index-key -- Positions identify source rows and columns. */
import { useContext, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { useClientSettings } from "~/hooks/useSettings";
import { observeResize } from "~/lib/observeResize";
import { PREVIEW_PAGE_ROWS } from "./largeTextProtocol";
import { SharedTooltipTrigger } from "~/components/ui/shared-tooltip";
import { createPositionMemory, PreviewPositionKey } from "./previewPosition";

const savedRowPositions = createPositionMemory<{
  position: number | "end";
  revealKey: string | null;
}>();

export default function VirtualTablePreview(props: {
  readonly name: string;
  readonly count: number;
  readonly columns: number;
  readonly getRows: (page: number) => readonly (readonly string[])[] | undefined;
  readonly loadPage?: (page: number) => void;
  readonly indexing?: boolean;
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
                <SharedTooltipTrigger
                  key={column}
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
                  label={props.header?.[column] ?? columnLabel(column)}
                />
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
    rowHeights?: ReadonlyMap<number, number> | undefined;
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
        const rowMinHeight = !props.source && row ? props.rowHeights?.get(index) : undefined;
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

interface ScrollModel {
  scale: number;
  maxFirst: number;
  heights: number[];
}

function logicalScrollTop(scrollTop: number, model: ScrollModel): number {
  const trackEnd = model.maxFirst * 29;
  let logicalTop = Math.min(trackEnd, scrollTop / model.scale);
  let remaining = Math.max(0, scrollTop - trackEnd * model.scale);
  for (const height of model.heights) {
    if (!remaining) break;
    logicalTop += Math.min(1, remaining / height) * 29;
    remaining = Math.max(0, remaining - height);
  }
  return logicalTop;
}

function pendingEndAt(node: HTMLElement, expectedTop: number | null): number | null {
  if (expectedTop === null) return null;
  // Layout can clamp the scroll offset while the bottom stays pinned.
  if (node.scrollHeight - node.clientHeight - node.scrollTop <= 1) return node.scrollTop;
  return Math.abs(node.scrollTop - expectedTop) > 1 ? null : expectedTop;
}

interface PendingReveal {
  row: number;
  attempts: number;
  expectedTop?: number | undefined;
}

function pendingRevealAt(node: HTMLElement, pending: PendingReveal | null): PendingReveal | null {
  if (pending?.expectedTop === undefined) return pending;
  const clampedTop = Math.min(pending.expectedTop, node.scrollHeight - node.clientHeight);
  return Math.abs(node.scrollTop - clampedTop) > 1 ? null : pending;
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
    entries: Map<number, CachedRowHeight>;
  }>({ key: "", entries: new Map() });
  const [rowHeights, setRowHeights] = useState<{
    key: string;
    heights: ReadonlyMap<number, number>;
  }>({ key: "", heights: new Map() });
  const [, setRowMeasureTick] = useState(0);
  const typographyKey = useClientSettings(
    (settings) => `${settings.fontFamilySans}:${settings.fontSizeInterface}`,
  );
  const [layout, setLayout] = useState({ offset: 0, height: 0, rowHeight: 29 });
  const [top, setTop] = useState(0);
  const pendingReveal = useRef<PendingReveal | null>(null);
  const pendingEnd = useRef<number | null>(null);
  const positionKey = useContext(PreviewPositionKey);
  const savedPosition = savedRowPositions.get(positionKey);
  const handledReveal = useRef<string | null>(savedPosition?.revealKey ?? null);
  const pendingRestore = useRef(savedPosition?.position);
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
  const scrollModel = useRef<ScrollModel>({ scale, maxFirst, heights: [] });
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
    pendingReveal.current = pendingRevealAt(node, pendingReveal.current);
    pendingEnd.current = pendingEndAt(node, pendingEnd.current);
    // Native-tail pixels cross rows of different heights before returning to the scaled track.
    const logicalTop = logicalScrollTop(node.scrollTop, previous);
    let nativeOffset = 0;
    let remaining = Math.max(0, logicalTop / 29 - maxFirst);
    for (const height of heights) {
      nativeOffset += Math.min(1, remaining) * height;
      remaining = Math.max(0, remaining - 1);
      if (!remaining) break;
    }
    node.scrollTop = Math.min(maxFirst * 29, logicalTop) * scale + nativeOffset;
    if (pendingEnd.current !== null) pendingEnd.current = node.scrollTop;
    const reveal = pendingReveal.current;
    if (reveal?.expectedTop !== undefined) reveal.expectedTop = node.scrollTop;
    setTop(node.scrollTop);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Scroll the DOM viewport to a requested line after its virtual track has committed.
  useLayoutEffect(() => {
    const node = ref.current;
    if (props.revealLine == null) {
      if (!props.indexing) handledReveal.current = null;
      pendingReveal.current = null;
      return;
    }
    const key = `${props.revealRequestId}:${props.revealLine}`;
    if (!node || !props.count || handledReveal.current === key) return;
    pendingRestore.current = undefined;
    const row = Math.min(props.count, Math.max(1, props.revealLine)) - 1;
    node.scrollTop = Math.max(0, (row - headerRows) * 29) * scale;
    setTop(node.scrollTop);
    pendingEnd.current = null;
    pendingReveal.current = { row, attempts: 0 };
    handledReveal.current = key;
  }, [props.indexing, props.revealLine, props.revealRequestId, props.count, headerRows, scale]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Return a reopened file to its saved row once that row has streamed in.
  useLayoutEffect(() => {
    const saved = pendingRestore.current;
    const node = ref.current;
    if (saved === undefined || !node) return;
    if (saved === "end" ? props.indexing : saved >= props.count) return;
    pendingRestore.current = undefined;
    node.scrollTop =
      saved === "end" ? node.scrollHeight : Math.max(0, (saved - headerRows) * 29) * scale;
    setTop(node.scrollTop);
    if (saved === "end") pendingEnd.current = node.scrollTop;
    else
      pendingReveal.current = {
        row: saved,
        attempts: 0,
        expectedTop: saved > maxFirst + headerRows ? node.scrollTop : undefined,
      };
  }, [props.count, props.indexing, headerRows, maxFirst, scale]);
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
    pendingEnd.current = null;
    if (pendingReveal.current?.expectedTop !== undefined) pendingReveal.current = null;
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
  const sizesKey = `${props.sizes.join(",")}|${typographyKey}`;
  const pageCount = Math.min(
    Math.ceil(visibleEnd / PREVIEW_PAGE_ROWS),
    Math.ceil(props.count / PREVIEW_PAGE_ROWS) - page,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Measure mounted rows across all columns before paint so horizontal column virtualization keeps row heights and vertical scroll position stable.
  useLayoutEffect(() => {
    const probe = rowProbeRef.current;
    if (!props.hasHorizontalOverflow || !probe) return;
    const probeStyle = getComputedStyle(probe);
    const cacheKey = `${sizesKey}|${probeStyle.font}`;
    if (rowHeightCacheRef.current.key !== cacheKey) {
      rowHeightCacheRef.current = { key: cacheKey, entries: new Map() };
    }
    const cache = rowHeightCacheRef.current.entries;
    const mountedIndices: number[] = [];
    const uncached: Array<{ index: number; row: readonly string[] }> = [];
    for (let pageOffset = 0; pageOffset < pageCount; pageOffset++) {
      const currentPage = page + pageOffset;
      const rows = props.getRows(currentPage);
      if (!rows) continue;
      const start = currentPage * PREVIEW_PAGE_ROWS;
      const limit = visibleEnd - pageOffset * PREVIEW_PAGE_ROWS;
      const count = Math.min(PREVIEW_PAGE_ROWS, props.count - start, limit);
      for (let local = 0; local < count; local++) {
        const index = start + local;
        if (props.header && index === 0) continue;
        const row = rows[local];
        if (!row) continue;
        mountedIndices.push(index);
        const existing = cache.get(index);
        if (existing && (existing.row === row || sameRowCells(existing.row, row))) {
          existing.row = row;
        } else {
          uncached.push({ index, row });
        }
      }
    }
    let hasRemainingUncached = false;
    if (uncached.length > 0) {
      const fontSize = Number.parseFloat(probeStyle.fontSize) || 12;
      const lineHeight = Number.parseFloat(probeStyle.lineHeight) || fontSize * 1.333;
      const { measured, remaining } = measureRowsFullHeight(
        probe,
        uncached,
        props.columns,
        props.sizes,
        fontSize,
        lineHeight,
        MAX_SYNC_SCAN_CHARS,
      );
      hasRemainingUncached = remaining;
      for (const [index, entry] of measured) cache.set(index, entry);
      if (cache.size > MAX_CACHED_ROW_HEIGHTS) {
        const keep = new Set(mountedIndices);
        for (const key of cache.keys()) {
          if (cache.size <= MAX_CACHED_ROW_HEIGHTS) break;
          if (!keep.has(key)) cache.delete(key);
        }
      }
    }
    const next = new Map<number, number>();
    for (const index of mountedIndices) {
      const height = cache.get(index)?.height;
      if (height && height > BASE_ROW_HEIGHT) next.set(index, height);
    }
    setRowHeights((old) =>
      old.key === cacheKey && sameRowHeightMap(old.heights, next)
        ? old
        : { key: cacheKey, heights: next },
    );
    if (hasRemainingUncached) {
      const frameId = requestAnimationFrame(() => setRowMeasureTick((tick) => tick + 1));
      return () => cancelAnimationFrame(frameId);
    }
    return undefined;
  });
  const activeRowHeights =
    props.hasHorizontalOverflow && rowHeights.key.startsWith(`${sizesKey}|`)
      ? rowHeights.heights
      : undefined;
  function tailRowsReady(last: number) {
    for (let index = first; index <= last; index++) {
      if (!props.getRows(Math.floor(index / PREVIEW_PAGE_ROWS))?.[index % PREVIEW_PAGE_ROWS])
        return false;
      if (props.hasHorizontalOverflow) {
        const measured = rowHeightCacheRef.current.entries.get(index);
        if (!measured || (activeRowHeights?.get(index) ?? BASE_ROW_HEIGHT) !== measured.height)
          return false;
      }
    }
    return true;
  }
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
    const node = ref.current;
    if (!node) return;
    const pending = pendingRevealAt(node, pendingReveal.current);
    pendingReveal.current = pending;
    if (!pending) return;
    const alignStart = pending.expectedTop !== undefined;
    const row = contentRef.current?.querySelector<HTMLElement>(
      `[data-preview-row="${pending.row}"]`,
    );
    if (
      !row ||
      !props.getRows(Math.floor(pending.row / PREVIEW_PAGE_ROWS))?.[pending.row % PREVIEW_PAGE_ROWS]
    )
      return;
    if (alignStart && !tailRowsReady(pending.row)) return;
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
      alignStart || bounds.top < viewport.top
        ? bounds.top - viewport.top
        : Math.min(bounds.bottom, bounds.top + viewport.height) > viewport.bottom
          ? Math.min(bounds.bottom, bounds.top + viewport.height) - viewport.bottom
          : 0;
    if (Math.abs(delta) < 1 || pending.attempts++ >= 8) {
      pendingReveal.current = null;
      return;
    }
    const before = node.scrollTop;
    node.scrollTop += delta * (nativeTail ? 1 : (scale * 29) / Math.max(29, bounds.height));
    if (Math.abs(node.scrollTop - before) < 1) pendingReveal.current = null;
    else if (alignStart) pending.expectedTop = node.scrollTop;
    setTop(node.scrollTop);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Complete End-key scrolling after the final worker row has loaded and its DOM layout has settled.
  useLayoutEffect(() => {
    const node = ref.current;
    const content = contentRef.current;
    if (!node) return;
    pendingEnd.current = pendingEndAt(node, pendingEnd.current);
    if (pendingEnd.current === null || !nativeTail || !content || !props.count) return;
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
    pendingEnd.current =
      Math.abs(row.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom) < 1 &&
      tailRowsReady(last)
        ? null
        : node.scrollTop;
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
          pendingEnd.current = null;
          if (pendingReveal.current?.expectedTop !== undefined) pendingReveal.current = null;
          event.preventDefault();
          node.scrollTop += delta * (nativeTail ? 1 : (scale * 29) / rowHeight());
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          pendingReveal.current = null;
          node.scrollTop = event.key === "Home" ? 0 : node.scrollHeight;
          pendingEnd.current = event.key === "End" ? node.scrollTop : null;
          setTop(node.scrollTop);
        }
      }}
      onScroll={(event) => {
        const node = event.currentTarget;
        const scrolled = node.scrollTop;
        setTop(scrolled);
        pendingRestore.current = undefined;
        const atEnd = scrolled > 0 && node.scrollHeight - node.clientHeight - scrolled <= 1;
        // Native scrolling can move away from the last offset written by the End effects.
        pendingEnd.current = pendingEndAt(node, pendingEnd.current);
        pendingReveal.current = pendingRevealAt(node, pendingReveal.current);
        savedRowPositions.set(positionKey, {
          position:
            atEnd && !props.indexing
              ? "end"
              : Math.min(
                  props.count - 1,
                  Math.floor(logicalScrollTop(scrolled, scrollModel.current) / 29) + headerRows,
                ),
          revealKey: handledReveal.current,
        });
      }}
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
const CELL_VERTICAL_INSET = 13;
const MAX_MEASURED_CELLS_PER_ROW = 16;
// Wider than any common glyph, so estimates never undercount lines.
const MAX_GLYPH_WIDTH_EM = 1.35;
const MAX_CACHED_ROW_HEIGHTS = 512;
const MAX_SYNC_SCAN_CHARS = 128_000;
const PROBE_CELL_CLASS_NAME =
  "box-border border-r border-b border-transparent px-3 py-1.5 whitespace-pre-wrap break-words tabular-nums";

interface CachedRowHeight {
  row: readonly string[];
  height: number;
}

interface RowCellCandidate {
  readonly column: number;
  readonly text: string;
  readonly upperLines: number;
}

/** Conservative greedy word-wrap upper bound on rendered lines without native text shaping. */
function estimateUpperLines(text: string, innerWidth: number, fontSize: number): number {
  const length = text.length;
  let lines = 1;
  let lineWidth = 0;
  let wordWidth = 0;
  for (let index = 0; index < length; index++) {
    const code = text.charCodeAt(index);
    if (code === 10 || code === 13) {
      if (code === 13 && index + 1 < length && text.charCodeAt(index + 1) === 10) index++;
      if (wordWidth > 0) {
        if (lineWidth > 0 && lineWidth + wordWidth > innerWidth) lines++;
        wordWidth = 0;
      }
      lines++;
      lineWidth = 0;
      continue;
    }
    if (code === 32 || code === 9) {
      const spaceWidth = (code === 9 ? 4.5 : 0.38) * fontSize;
      if (wordWidth > 0) {
        if (lineWidth > 0 && lineWidth + wordWidth > innerWidth) {
          lines++;
          lineWidth = wordWidth;
        } else {
          lineWidth += wordWidth;
        }
        wordWidth = 0;
      }
      lineWidth += spaceWidth;
      if (lineWidth > innerWidth) {
        lines++;
        lineWidth = 0;
      }
      continue;
    }
    const charWidth = MAX_GLYPH_WIDTH_EM * fontSize;
    wordWidth += charWidth;
    if (wordWidth > innerWidth) {
      if (lineWidth > 0) {
        lines++;
        lineWidth = 0;
      }
      lines++;
      wordWidth = charWidth;
    }
  }
  if (wordWidth > 0 && lineWidth > 0 && lineWidth + wordWidth > innerWidth) lines++;
  return lines;
}

function collectRowHeightCandidates(
  row: readonly string[],
  columns: number,
  sizes: readonly number[],
  fontSize: number,
): { candidates: RowCellCandidate[]; scannedChars: number } {
  const candidates: RowCellCandidate[] = [];
  const limit = Math.min(columns, row.length);
  const maxGlyphWidth = fontSize * MAX_GLYPH_WIDTH_EM;
  let scannedChars = 0;
  for (let column = 0; column < limit; column++) {
    const text = row[column];
    if (!text) continue;
    const width = sizes[column];
    if (!width) continue;
    const innerWidth = Math.max(1, width - CELL_HORIZONTAL_INSET);
    const hasControlWhitespace = text.includes("\n") || text.includes("\r") || text.includes("\t");
    if (!hasControlWhitespace && text.length * maxGlyphWidth <= innerWidth) continue;
    scannedChars += text.length;
    const upperLines = estimateUpperLines(text, innerWidth, fontSize);
    if (!hasControlWhitespace && upperLines <= 1) continue;
    candidates.push({ column, text, upperLines });
  }
  if (candidates.length > MAX_MEASURED_CELLS_PER_ROW) {
    candidates.sort((left, right) => right.upperLines - left.upperLines);
  }
  return { candidates, scannedChars };
}

function measureProbeEntries(
  probe: HTMLElement,
  entries: ReadonlyArray<{ index: number; column: number; text: string }>,
  sizes: readonly number[],
  results: Map<number, CachedRowHeight>,
): void {
  if (entries.length === 0) return;
  const fragment = document.createDocumentFragment();
  const nodes: Array<{ index: number; node: HTMLDivElement }> = [];
  for (const entry of entries) {
    const node = document.createElement("div");
    node.className = PROBE_CELL_CLASS_NAME;
    node.style.width = `${sizes[entry.column]}px`;
    node.textContent = entry.text;
    fragment.append(node);
    nodes.push({ index: entry.index, node });
  }
  probe.replaceChildren(fragment);
  for (const { index, node } of nodes) {
    const height = node.getBoundingClientRect().height;
    const current = results.get(index);
    if (current && height > current.height) current.height = height;
  }
  probe.replaceChildren();
}

function measureRowsFullHeight(
  probe: HTMLElement,
  rows: ReadonlyArray<{ index: number; row: readonly string[] }>,
  columns: number,
  sizes: readonly number[],
  fontSize: number,
  lineHeight: number,
  maxScanChars: number,
): { measured: Map<number, CachedRowHeight>; remaining: boolean } {
  const measured = new Map<number, CachedRowHeight>();
  const firstPassEntries: Array<{ index: number; column: number; text: string }> = [];
  const overflowRows: Array<{ index: number; candidates: RowCellCandidate[] }> = [];
  let scannedChars = 0;
  let remaining = false;
  for (const { index, row } of rows) {
    if (measured.size > 0 && scannedChars >= maxScanChars) {
      remaining = true;
      break;
    }
    const collected = collectRowHeightCandidates(row, columns, sizes, fontSize);
    scannedChars += collected.scannedChars;
    measured.set(index, { row, height: BASE_ROW_HEIGHT });
    const firstBatchCount = Math.min(collected.candidates.length, MAX_MEASURED_CELLS_PER_ROW);
    for (let candidateIndex = 0; candidateIndex < firstBatchCount; candidateIndex++) {
      const candidate = collected.candidates[candidateIndex]!;
      firstPassEntries.push({ index, column: candidate.column, text: candidate.text });
    }
    if (collected.candidates.length > MAX_MEASURED_CELLS_PER_ROW) {
      overflowRows.push({ index, candidates: collected.candidates });
    }
  }
  measureProbeEntries(probe, firstPassEntries, sizes, measured);
  if (overflowRows.length > 0) {
    const secondPassEntries: Array<{ index: number; column: number; text: string }> = [];
    for (const { index, candidates } of overflowRows) {
      const bestHeight = measured.get(index)?.height ?? BASE_ROW_HEIGHT;
      const measuredLines = Math.max(
        1,
        Math.floor((bestHeight - CELL_VERTICAL_INSET + 0.5) / lineHeight),
      );
      for (
        let candidateIndex = MAX_MEASURED_CELLS_PER_ROW;
        candidateIndex < candidates.length;
        candidateIndex++
      ) {
        const candidate = candidates[candidateIndex]!;
        if (candidate.upperLines <= measuredLines) break;
        secondPassEntries.push({ index, column: candidate.column, text: candidate.text });
      }
    }
    measureProbeEntries(probe, secondPassEntries, sizes, measured);
  }
  return { measured, remaining };
}

function sameRowCells(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameRowHeightMap(
  left: ReadonlyMap<number, number>,
  right: ReadonlyMap<number, number>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [index, height] of left) {
    if (right.get(index) !== height) return false;
  }
  return true;
}

function columnLabel(index: number): string {
  let label = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  return label;
}
