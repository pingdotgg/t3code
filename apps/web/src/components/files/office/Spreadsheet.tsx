import { observeResize } from "~/lib/observeResize";
import { useEffect, useRef, useState } from "react";
import {
  cellAtPoint,
  normalizeRange,
  selectionAt,
  selectionKeyReducer,
  extendTo,
  hyperlinkAtCell,
  safeExternalHyperlink,
  parseHyperlinkLocation,
  type Selection,
  type CellAddr,
} from "@betteroffice/xlsx/headless";
import { FileSurfaceLoading, FileSurfaceNotice } from "../fileSurfaceChrome";
import { createWorkerClient, SupersededError } from "./worker-rpc";
import type { SheetLayout, SheetMethods, SheetFrameRequest, SheetTab } from "./sheet-protocol";
import {
  coverMerges,
  contains,
  lastCell,
  settleMerges,
  skipHidden,
  columnName,
} from "./sheet-cells";
import {
  paintCells,
  paintHeaders,
  paintSelection,
  shiftGrid,
  headerHeight,
  type Painted,
} from "./sheet-paint";
import { externalUrl } from "./links";

type Client = ReturnType<typeof createWorkerClient<SheetMethods>>;
type Opened = {
  engine: Client;
  tabs: readonly SheetTab[];
  layout: SheetLayout;
  target?: CellAddr | undefined;
};
export default function Spreadsheet(props: {
  bytes: ArrayBuffer;
  onDetails: (text: string) => void;
  onError: (cause: unknown) => void;
}) {
  const { onError, bytes: source, onDetails } = props;
  const [opened, setOpened] = useState<Opened>();
  const [error, setError] = useState("");
  const picking = useRef<AbortController | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Open the workbook worker and cancel workbook and sheet requests when the source changes or unmounts.
  useEffect(() => {
    const controller = new AbortController();
    const worker = new Worker(new URL("./spreadsheet.worker.ts", import.meta.url), {
      type: "module",
    });
    const engine = createWorkerClient<SheetMethods>(worker);
    const fail = (cause: unknown) => {
      if (!controller.signal.aborted) onError(cause);
    };
    worker.addEventListener("error", fail);
    worker.addEventListener("messageerror", fail);
    const bytes = source.slice(0);
    void engine
      .call("open", { bytes }, { transfer: [bytes], signal: controller.signal })
      .then((value) => {
        if (!value) throw new Error("This workbook has no visible sheets.");
        setOpened({ ...value, engine });
        onDetails(`${value.tabs.length} sheets`);
      })
      .catch(fail);
    return () => {
      controller.abort();
      picking.current?.abort();
      engine.close();
    };
  }, [source, onDetails, onError]);
  const show = (sheet: number, target?: CellAddr) => {
    if (!opened) return;
    picking.current?.abort();
    if (sheet === opened.layout.info.activeSheet) return;
    const controller = new AbortController();
    picking.current = controller;
    void opened.engine
      .call("show", { sheet }, { signal: controller.signal })
      .then((layout) => {
        setError("");
        setOpened({ ...opened, layout, target });
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("This sheet could not be opened.");
      });
  };
  if (!opened) return <FileSurfaceLoading />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error ? <FileSurfaceNotice>{error}</FileSurfaceNotice> : null}
      <SpreadsheetGrid
        key={opened.layout.info.activeSheet}
        engine={opened.engine}
        layout={opened.layout}
        initialCell={opened.target}
        onNavigate={(name, cell) => {
          const tab = opened.tabs.find((tab) => tab.name.toLowerCase() === name.toLowerCase());
          if (tab) show(tab.index, cell);
        }}
      />
      <div
        role="tablist"
        aria-label="Sheets"
        className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-t border-border px-2"
        onKeyDown={(event) => {
          const current = opened.tabs.findIndex(
            (tab) => tab.index === opened.layout.info.activeSheet,
          );
          const next =
            event.key === "ArrowRight"
              ? (current + 1) % opened.tabs.length
              : event.key === "ArrowLeft"
                ? (current + opened.tabs.length - 1) % opened.tabs.length
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? opened.tabs.length - 1
                    : -1;
          if (next < 0) return;
          event.preventDefault();
          const tab = opened.tabs[next];
          if (tab) show(tab.index);
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}
      >
        {opened.tabs.map((tab) => (
          <button
            key={tab.index}
            type="button"
            role="tab"
            aria-selected={tab.index === opened.layout.info.activeSheet}
            tabIndex={tab.index === opened.layout.info.activeSheet ? 0 : -1}
            onClick={() => show(tab.index)}
            className="h-7 shrink-0 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-accent aria-selected:bg-accent aria-selected:text-foreground"
          >
            {tab.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function SpreadsheetGrid(props: {
  engine: Client;
  layout: SheetLayout;
  initialCell: CellAddr | undefined;
  onNavigate: (sheet: string, cell: CellAddr) => void;
}) {
  const { onNavigate, layout, engine, initialCell } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState("");
  const [reader, setReader] = useState<{ row: number; col: number; text: string }[]>([]);
  const [active, setActive] = useState({ row: 0, col: 0 });
  const navigate = useRef(onNavigate);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the installed native pointer listener calling the latest navigation handler without restarting the canvas engine.
  useEffect(() => {
    navigate.current = onNavigate;
  }, [onNavigate]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own canvas painting, worker requests, resize observation, and native scroll, keyboard, and pointer listeners for this sheet.
  useEffect(() => {
    const root = scroller.current;
    const target = canvas.current;
    const space = spacer.current;
    if (!root || !target || !space) return;
    const context = target.getContext("2d");
    if (!context) return;
    const controller = new AbortController();
    const info = layout.info;
    const sheet = info.activeSheet;
    const frozen = { rows: info.frozenRows, cols: info.frozenCols };
    const headers = { width: 44, height: headerHeight };
    let selection: Selection = selectionAt(initialCell ?? { row: 0, col: 0 });
    let painted: Painted | undefined;
    let grid: ReturnType<typeof shiftGrid> | undefined;
    let raf = 0;
    let requested = "";
    let sent = 0;
    let received = 0;
    let drag = false;
    let header: "row" | "column" | "all" | undefined;
    let pressed: { row: number; col: number } | undefined;
    let end: { x: number; y: number } | undefined;
    let left = info.initialScrollX;
    let top = info.initialScrollY;
    let reachX = 0;
    let reachY = 0;
    let readController: AbortController | undefined;
    const range = () => coverMerges(normalizeRange(selection), layout.merges);
    const at = (cell: { row: number; col: number }) => {
      const merge = layout.merges.find((item) => contains(item, cell));
      return selectionAt(merge ? { row: merge.top, col: merge.left } : cell);
    };
    const schedule = () => {
      if (raf || controller.signal.aborted) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        paint();
      });
    };
    const resizeArea = () => {
      const width = Math.min(
        (end?.x ?? Infinity) + (painted?.frame.frozen.width ?? 0),
        Math.max(info.contentWidth, layout.chartWidth, reachX, left + root.clientWidth) +
          root.clientWidth,
      );
      const height = Math.min(
        (end?.y ?? Infinity) + (painted?.frame.frozen.height ?? 0),
        Math.max(info.contentHeight, layout.chartHeight, reachY, top + root.clientHeight) +
          root.clientHeight,
      );
      space.style.width = `${headers.width + width}px`;
      space.style.height = `${headers.height + height}px`;
    };
    const paint = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = root.clientWidth;
      const height = root.clientHeight;
      const size = { width: width - headers.width, height: height - headers.height };
      if (size.width <= 0 || size.height <= 0) return;
      left = root.scrollLeft;
      top = root.scrollTop;
      resizeArea();
      const input: SheetFrameRequest = {
        sheet,
        x: left,
        y: top,
        ...size,
        ratio,
        offset: { x: 0, y: 0 },
        wider: undefined,
      };
      const key = JSON.stringify(input);
      if (key !== requested) {
        requested = key;
        sent += 1;
        const order = sent;
        void engine
          .call("frame", input, { key: "frame", signal: controller.signal })
          .then((reply) => {
            if (order < received || controller.signal.aborted) {
              reply?.bitmap.close();
              return;
            }
            received = order;
            if (!reply) {
              setNotice("These cells could not be drawn. Try scrolling to another area.");
              return;
            }
            setNotice("");
            painted?.frame.bitmap.close();
            painted = { request: input, frame: reply };
            end = reply.end;
            schedule();
          })
          .catch((cause: unknown) => {
            if (!(cause instanceof SupersededError) && !controller.signal.aborted)
              setNotice("These cells could not be drawn.");
          });
      }
      if (
        target.width !== Math.round(width * ratio) ||
        target.height !== Math.round(height * ratio)
      ) {
        target.width = Math.round(width * ratio);
        target.height = Math.round(height * ratio);
        target.style.width = `${width}px`;
        target.style.height = `${height}px`;
      }
      if (!painted) {
        context.fillStyle = "#fff";
        context.fillRect(0, 0, target.width, target.height);
        return;
      }
      paintCells(context, painted, { ratio, headers, x: left, y: top, ...size });
      grid =
        painted.frame.grid &&
        shiftGrid(painted.frame.grid, frozen, painted.frame.frozen, {
          x: painted.frame.viewport.x - left,
          y: painted.frame.viewport.y - top,
        });
      if (!grid) return;
      const anchor = selection.anchor;
      paintSelection(context, {
        grid,
        ratio,
        headers,
        ...size,
        range: range(),
        active: coverMerges(
          { top: anchor.row, left: anchor.col, bottom: anchor.row, right: anchor.col },
          layout.merges,
        ),
      });
      paintHeaders(context, { grid, ratio, headers, width, height, selected: range() });
    };
    const read = () => {
      const focus = selection.focus;
      setActive(focus);
      readController?.abort();
      readController = new AbortController();
      const top = Math.max(0, focus.row - 5);
      const left = Math.max(0, focus.col - 3);
      const range = {
        top,
        left,
        bottom: Math.min(lastCell.row, top + 10),
        right: Math.min(lastCell.col, left + 6),
      };
      void engine
        .call("cells", { sheet, range }, { key: "reader", signal: readController.signal })
        .then((rows) => {
          if (!controller.signal.aborted)
            setReader(
              rows.flatMap((row, r) =>
                row.map((text, c) => ({ row: top + r, col: left + c, text })),
              ),
            );
        })
        .catch(() => undefined);
    };
    const select = (next: Selection) => {
      selection = next;
      read();
      schedule();
    };
    const reveal = () => {
      const cell = selection.focus;
      void engine
        .call("position", { sheet, cell }, { key: "position", signal: controller.signal })
        .then((position) => {
          if (!position || controller.signal.aborted) return;
          const panes = painted?.frame.frozen ?? { width: 0, height: 0 };
          const place = (start: number, next: number, current: number, visible: number) =>
            start < current ? start : next > current + visible ? next - visible : current;
          const x =
            cell.col < info.frozenCols
              ? left
              : place(
                  position.start.x,
                  position.next.x,
                  left,
                  root.clientWidth - headers.width - panes.width,
                );
          const y =
            cell.row < info.frozenRows
              ? top
              : place(
                  position.start.y,
                  position.next.y,
                  top,
                  root.clientHeight - headers.height - panes.height,
                );
          reachX = Math.max(reachX, x + root.clientWidth);
          reachY = Math.max(reachY, y + root.clientHeight);
          resizeArea();
          root.scrollTo({ left: Math.max(0, x), top: Math.max(0, y) });
          schedule();
        })
        .catch(() => undefined);
    };
    const hit = (event: PointerEvent) => {
      if (!grid) return;
      const rect = target.getBoundingClientRect();
      const x = event.clientX - rect.left - headers.width;
      const y = event.clientY - rect.top - headers.height;
      const frame = painted?.frame;
      if (
        frame &&
        ((x >= frame.frozen.width && x < frame.frozen.width + frame.viewport.x - left) ||
          (y >= frame.frozen.height && y < frame.frozen.height + frame.viewport.y - top))
      )
        return;
      const cell = cellAtPoint(
        grid,
        Math.max(0, Math.min(x, root.clientWidth - headers.width - 1)),
        Math.max(0, Math.min(y, root.clientHeight - headers.height - 1)),
      );
      return cell ? { cell, x, y } : undefined;
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const found = hit(event);
      if (!found) return;
      root.focus({ preventScroll: true });
      root.setPointerCapture(event.pointerId);
      drag = true;
      header = found.x < 0 ? (found.y < 0 ? "all" : "row") : found.y < 0 ? "column" : undefined;
      pressed = header ? undefined : found.cell;
      if (found.x < 0 && found.y < 0)
        select({ anchor: { row: lastCell.row, col: lastCell.col }, focus: { row: 0, col: 0 } });
      else if (found.x < 0)
        select({
          anchor: { row: found.cell.row, col: lastCell.col },
          focus: { row: found.cell.row, col: 0 },
        });
      else if (found.y < 0)
        select({
          anchor: { row: lastCell.row, col: found.cell.col },
          focus: { row: 0, col: found.cell.col },
        });
      else select(event.shiftKey ? extendTo(selection, found.cell) : at(found.cell));
    };
    const pointerMove = (event: PointerEvent) => {
      if (!drag) return;
      const found = hit(event);
      if (found && header !== "all")
        select(
          extendTo(selection, {
            row: header === "column" ? 0 : found.cell.row,
            col: header === "row" ? 0 : found.cell.col,
          }),
        );
    };
    const pointerUp = (event: PointerEvent) => {
      drag = false;
      const found = hit(event);
      if (!found || !pressed || found.cell.row !== pressed.row || found.cell.col !== pressed.col)
        return;
      const cell = at(found.cell).anchor;
      const list = painted?.frame;
      if (!list) return;
      const link = hyperlinkAtCell(
        { width: 0, height: 0, commands: [], hyperlinks: [...list.hyperlinks] },
        cell.row,
        cell.col,
      );
      if (!link) return;
      const url = safeExternalHyperlink(link);
      const safe = url && externalUrl(url);
      if (safe) {
        window.open(safe, "_blank", "noopener,noreferrer");
        return;
      }
      const internal =
        link.location && parseHyperlinkLocation(link.location, info.sheetNames[sheet] ?? "");
      if (!internal) return;
      if (internal.sheetName.toLowerCase() !== (info.sheetNames[sheet] ?? "").toLowerCase())
        navigate.current(internal.sheetName, { row: internal.row, col: internal.col });
      else {
        select(at({ row: internal.row, col: internal.col }));
        reveal();
      }
    };
    const copy = () => {
      const used = layout.used;
      const selected = range();
      const clipped = {
        ...selected,
        bottom: Math.min(selected.bottom, Math.max(selected.top, used?.bottom ?? 0)),
        right: Math.min(selected.right, Math.max(selected.left, used?.right ?? 0)),
      };
      if ((clipped.bottom - clipped.top + 1) * (clipped.right - clipped.left + 1) > 200_000) {
        setNotice("Select fewer than 200,000 cells to copy.");
        return;
      }
      void engine
        .call("copy", { sheet, range: clipped }, { signal: controller.signal })
        .then((text) => {
          if (text === undefined) throw new Error("No cells");
          return navigator.clipboard.writeText(text);
        })
        .catch(() => {
          if (!controller.signal.aborted) setNotice("The selected cells could not be copied.");
        });
    };
    const key = (event: KeyboardEvent) => {
      const command = event.ctrlKey || event.metaKey;
      if (command && event.key.toLowerCase() === "c") {
        event.preventDefault();
        copy();
        return;
      }
      if (event.key === "Tab" || event.altKey || event.isComposing) return;
      const action = selectionKeyReducer(selection, event, {
        rows: Math.max((layout.used?.bottom ?? 0) + 1, selection.focus.row + 1),
        cols: Math.max((layout.used?.right ?? 0) + 1, selection.focus.col + 1),
        rowsPerPage: Math.max(1, Math.floor((root.clientHeight - headerHeight) / 20)),
      });
      if (action.type !== "move") return;
      event.preventDefault();
      select(
        skipHidden(
          selection.focus,
          settleMerges(selection, action.selection, layout.merges),
          layout.hidden,
        ),
      );
      reveal();
    };
    const cancel = () => {
      drag = false;
    };
    root.addEventListener("scroll", schedule);
    root.addEventListener("keydown", key);
    root.addEventListener("pointerdown", pointerDown);
    root.addEventListener("pointermove", pointerMove);
    root.addEventListener("pointerup", pointerUp);
    root.addEventListener("pointercancel", cancel);
    const unobserve = observeResize(root, schedule);
    window.addEventListener("resize", schedule);
    resizeArea();
    root.scrollTo({ left, top });
    if (initialCell) {
      selection = at(initialCell);
      reveal();
    }
    read();
    schedule();
    return () => {
      controller.abort();
      readController?.abort();
      cancelAnimationFrame(raf);
      unobserve();
      window.removeEventListener("resize", schedule);
      painted?.frame.bitmap.close();
      root.removeEventListener("scroll", schedule);
      root.removeEventListener("keydown", key);
      root.removeEventListener("pointerdown", pointerDown);
      root.removeEventListener("pointermove", pointerMove);
      root.removeEventListener("pointerup", pointerUp);
      root.removeEventListener("pointercancel", cancel);
    };
  }, [engine, layout, initialCell]);
  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        ref={scroller}
        dir="ltr"
        tabIndex={0}
        role="grid"
        aria-label={layout.info.sheetNames[layout.info.activeSheet]}
        aria-readonly="true"
        aria-multiselectable="true"
        aria-rowcount={lastCell.row + 1}
        aria-colcount={lastCell.col + 1}
        aria-activedescendant={`office-cell-${active.row}-${active.col}`}
        className="relative min-h-0 min-w-0 flex-1 select-none overflow-auto bg-white outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div
          ref={spacer}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0"
        />
        <div aria-hidden="true" className="sticky left-0 top-0 h-0 w-0">
          <canvas ref={canvas} className="absolute left-0 top-0 block" />
        </div>
        <div className="sr-only">
          {[...new Set(reader.map((cell) => cell.row))].map((row) => (
            <div key={row} role="row" aria-rowindex={row + 1}>
              {reader
                .filter((cell) => cell.row === row)
                .map((cell) => (
                  <span
                    key={cell.col}
                    role="gridcell"
                    id={`office-cell-${cell.row}-${cell.col}`}
                    aria-colindex={cell.col + 1}
                    aria-label={`${columnName(cell.col)}${cell.row + 1}`}
                  >
                    {cell.text}
                  </span>
                ))}
            </div>
          ))}
        </div>
      </div>
      {notice ? (
        <div
          role="status"
          className="absolute inset-x-3 bottom-3 rounded-md bg-background p-2 text-xs text-foreground shadow-md"
        >
          {notice}
        </div>
      ) : null}
    </div>
  );
}
