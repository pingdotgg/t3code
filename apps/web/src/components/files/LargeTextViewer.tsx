import { msg, T, useGT, useMessages } from "gt-react";
import { useEffect, useImperativeHandle, useRef, useState, type RefObject } from "react";
import { m } from "~/i18n/messages";
import { Spinner } from "~/components/ui/spinner";
import { delimitedColumnKinds, parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { useClientSettings } from "~/hooks/useSettings";
import { FileSurfaceFailure, FileSurfaceLoading, FileSurfaceNotice } from "./fileSurfaceChrome";
import {
  LARGE_TEXT_MAX_COLUMNS,
  PREVIEW_PAGE_ROWS,
  type TextPreviewResult,
} from "./largeTextProtocol";
import { previewFailureText } from "./previewFailureMessages";
import VirtualTablePreview from "./VirtualTablePreview";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const FIRST_SCREEN_BYTES = 16 * 1024;

function firstScreen(text: string, delimiter: "," | "\t" | null, complete: boolean) {
  if (!text || text.includes("\0")) return [];
  const rows = delimiter
    ? parseDelimitedPreview(text, delimiter, {
        maxRows: PREVIEW_PAGE_ROWS * 2 + 1,
        maxColumns: LARGE_TEXT_MAX_COLUMNS + 1,
        maxCellLength: FIRST_SCREEN_BYTES,
      }).rows
    : text
        .replace(/\r?\n$|\r$/, "")
        .split(/\r\n|\n|\r/)
        .slice(0, PREVIEW_PAGE_ROWS * 2 + 1)
        .map((line) => [line]);
  // A byte range can end inside a quoted record or a UTF-8 character.
  if (!complete) rows.pop();
  return rows.slice(0, PREVIEW_PAGE_ROWS * 2);
}

type Meta = Extract<TextPreviewResult, { type: "meta" }>;

function firstScreenState(text: string, delimiter: "," | "\t" | null, complete: boolean) {
  const rows = firstScreen(text, delimiter, complete);
  if (!rows.length) return null;
  const widest = rows.reduce((max, row) => Math.max(max, row.length), 1);
  return {
    pages: new Map(
      [0, PREVIEW_PAGE_ROWS]
        .filter((start) => start < rows.length)
        .map((start) => [start / PREVIEW_PAGE_ROWS, rows.slice(start, start + PREVIEW_PAGE_ROWS)]),
    ),
    meta: {
      type: "meta",
      count: rows.length,
      columns: Math.min(LARGE_TEXT_MAX_COLUMNS, widest),
      columnsTruncated: widest > LARGE_TEXT_MAX_COLUMNS,
      complete: false,
    } satisfies Meta as Meta,
  };
}

// Reopening a recent file paints its first screen at once while the worker indexes it again.
const recentFirstScreens = new Map<string, { text: string; complete: boolean }>();

function rememberFirstScreen(src: string, text: string, complete: boolean) {
  recentFirstScreens.delete(src);
  recentFirstScreens.set(src, { text, complete });
  if (recentFirstScreens.size > 32)
    recentFirstScreens.delete(recentFirstScreens.keys().next().value!);
}

export default function LargeTextViewer(props: {
  readonly name: string;
  readonly src?: string;
  readonly text?: string;
  readonly sizeBytes?: number;
  readonly onRetry?: () => void;
  readonly copyContents?: RefObject<(() => Promise<string>) | null>;
  readonly delimiter: "," | "\t" | null;
  readonly revealLine?: number | null;
  readonly revealRequestId?: number;
  /** A preview's own wrap toggle; omitted follows the word wrap setting. */
  readonly wordWrap?: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [initial] = useState(() => {
    const cached = props.src === undefined ? undefined : recentFirstScreens.get(props.src);
    return cached ? firstScreenState(cached.text, props.delimiter, cached.complete) : null;
  });
  const [meta, setMeta] = useState<Meta | null>(initial?.meta ?? null);
  const [pages, setPages] = useState(initial?.pages ?? new Map<number, string[][]>());
  const [error, setError] = useState<string | null>(null);
  const worker = useRef<Worker | null>(null);
  const copyPending = useRef<{
    resolve: (text: string) => void;
    reject: (cause: Error) => void;
  } | null>(null);
  const pending = useRef(new Set<number>());
  const defaultWordWrap = useClientSettings((settings) => settings.wordWrap);
  const wordWrap = props.wordWrap ?? defaultWordWrap;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the prefix fetch and indexing worker, cancelling requests and pending copies when the source changes or unmounts.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- A replacement source must discard the previous worker's error and pages.
    setError(null);
    setMeta(null);
    setPages(new Map());
    const controller = new AbortController();
    let indexed = false;
    let prefetched = false;
    const paintFirstScreen = (text: string, complete: boolean) => {
      if (indexed || controller.signal.aborted) return;
      const screen = firstScreenState(text, props.delimiter, complete);
      if (!screen) return;
      prefetched = true;
      setPages(screen.pages);
      setMeta(screen.meta);
    };
    const startWorker = () => {
      if (controller.signal.aborted) return;
      const engine = new Worker(new URL("./largeText.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.current = engine;
      engine.addEventListener("message", (event: MessageEvent<TextPreviewResult>) => {
        const result = event.data;
        if (result.type === "copy") {
          copyPending.current?.resolve(result.text);
          copyPending.current = null;
        } else if (result.type === "error") {
          copyPending.current?.reject(new Error(previewFailureText(result)));
          copyPending.current = null;
          if (result.operation !== "copy") setError(previewFailureText(result));
        } else if (result.type === "meta") {
          indexed = true;
          if (prefetched) {
            // Keeps the painted first screen until the worker's own pages replace it.
            prefetched = false;
            pending.current.clear();
            for (const index of [0, 1]) {
              if (index * PREVIEW_PAGE_ROWS >= result.count) break;
              pending.current.add(index);
              engine.postMessage({ type: "page", index }, []);
            }
          }
          setMeta(result);
        } else if (result.type === "page") {
          pending.current.delete(result.index);
          setPages((old) => {
            const previous = old.get(result.index);
            if (
              previous?.length === result.rows.length &&
              previous.every(
                (row, index) =>
                  row.length === result.rows[index]!.length &&
                  row.every((cell, column) => cell === result.rows[index]![column]),
              )
            )
              return old;
            const next = new Map(old);
            next.delete(result.index);
            next.set(result.index, result.rows);
            if (next.size > 12) next.delete([...next.keys()].find((key) => key !== 0)!);
            return next;
          });
        }
      });
      engine.addEventListener("error", () => {
        copyPending.current?.reject(new Error(m(msg("The text viewer stopped."))));
        copyPending.current = null;
        setError(m(msg("Could not load the text viewer. Close the file and try again.")));
      });
      engine.postMessage(
        {
          type: "open",
          src: props.src,
          text: props.text,
          sizeBytes: props.sizeBytes,
          delimiter: props.delimiter,
        },
        [],
      );
    };
    const scheduleWorker = () => {
      if (prefetched) requestAnimationFrame(() => requestAnimationFrame(startWorker));
      else startWorker();
    };
    // Only this bounded prefix is parsed on the main thread. Indexing the full
    // file and fetching later pages remain in the worker.
    const cached = props.src === undefined ? undefined : recentFirstScreens.get(props.src);
    if (props.sizeBytes === 0) {
      startWorker();
    } else if (cached) {
      paintFirstScreen(cached.text, cached.complete);
      scheduleWorker();
    } else if (props.text !== undefined) {
      paintFirstScreen(
        props.text.slice(0, FIRST_SCREEN_BYTES),
        props.text.length <= FIRST_SCREEN_BYTES,
      );
      scheduleWorker();
    } else if (props.src) {
      const src = props.src;
      void fetch(src, {
        headers: { Range: `bytes=0-${FIRST_SCREEN_BYTES - 1}` },
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (
            !response.ok ||
            Number(response.headers.get("content-length")) > FIRST_SCREEN_BYTES ||
            response.status !== 206
          ) {
            await response.body?.cancel();
            return;
          }
          const total = Number(response.headers.get("content-range")?.split("/")[1]);
          const text = await response.text();
          rememberFirstScreen(src, text, total <= FIRST_SCREEN_BYTES);
          paintFirstScreen(text, total <= FIRST_SCREEN_BYTES);
        })
        .catch(() => {
          // The worker reports authorization, network and format failures.
        })
        .finally(scheduleWorker);
    } else startWorker();
    return () => {
      controller.abort();
      copyPending.current?.reject(new Error(m(msg("Preview closed."))));
      copyPending.current = null;
      worker.current?.terminate();
      worker.current = null;
      pending.current.clear();
    };
  }, [props.src, props.text, props.delimiter, props.sizeBytes]);
  useImperativeHandle(
    props.copyContents,
    () => () =>
      new Promise<string>((resolve, reject) => {
        if (!worker.current) {
          reject(new Error(m(msg("The file is unavailable."))));
          return;
        }
        if (copyPending.current) {
          reject(new Error(m(msg("Another copy is in progress."))));
          return;
        }
        copyPending.current = { resolve, reject };
        worker.current.postMessage({ type: "copy" }, []);
      }),
    [],
  );
  if (error)
    return (
      <FileSurfaceFailure message={error} {...(props.onRetry ? { onRetry: props.onRetry } : {})} />
    );
  if (!meta || (meta.count > 0 && !pages.has(0))) return <FileSurfaceLoading />;
  const header = props.delimiter ? pages.get(0)?.[0] : undefined;
  const columnKinds = props.delimiter
    ? delimitedColumnKinds(pages.get(0)?.slice(1) ?? [], meta.columns)
    : undefined;
  const rowCount = Math.max(0, meta.count - 1);
  const columnCount = meta.count ? meta.columns : 0;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        className="order-last flex shrink-0 flex-wrap items-center gap-x-1 px-4 py-1 text-caption text-dim-foreground tabular-nums"
        role="status"
      >
        {/* Counts appear once indexing ends; the prefix count alone would understate the file. */}
        {meta.complete ? (
          <Tooltip>
            <TooltipTrigger render={<span tabIndex={0} />}>
              {props.delimiter
                ? gt("{count, plural, one {{formatted} row} other {{formatted} rows}}", {
                    count: rowCount,
                    formatted: rowCount.toLocaleString(),
                  })
                : gt("{count, plural, one {{formatted} line} other {{formatted} lines}}", {
                    count: meta.count,
                    formatted: meta.count.toLocaleString(),
                  })}
            </TooltipTrigger>
            <TooltipPopup>
              {props.delimiter ? (
                <>
                  <span className="block">
                    {gt("{count, plural, one {{formatted} column} other {{formatted} columns}}", {
                      count: columnCount,
                      formatted: columnCount.toLocaleString(),
                    })}
                  </span>
                  <span className="block">
                    {props.delimiter === "," ? gt("Comma separated") : gt("Tab separated")}
                  </span>
                </>
              ) : null}
              {meta.sizeBytes !== undefined ? (
                <span className="block">
                  {meta.sizeBytes === 0
                    ? gt("0 bytes")
                    : formatAttachmentSize(meta.sizeBytes, messages)}
                </span>
              ) : null}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {!meta.complete ? (
        <div className="pointer-events-none absolute right-4 bottom-3 z-20">
          <Spinner size="md" tone="muted" />
        </div>
      ) : null}
      {meta.columnsTruncated ? (
        <FileSurfaceNotice>
          <T>Showing the first 1,024 columns. Source and Save retain every column.</T>
        </FileSurfaceNotice>
      ) : null}
      {meta.count > 0 ? (
        <VirtualTablePreview
          name={props.name}
          count={meta.count}
          columns={meta.columns}
          header={header}
          columnKinds={columnKinds}
          source={!props.delimiter}
          wrap={wordWrap}
          revealLine={meta.complete ? (props.revealLine ?? null) : null}
          revealRequestId={props.revealRequestId ?? 0}
          getRows={(page) => pages.get(page)}
          loadPage={(page) => {
            if (pending.current.has(page)) return;
            pending.current.add(page);
            worker.current?.postMessage({ type: "page", index: page });
          }}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-meta text-muted-foreground">
          <T>This file is empty.</T>
        </div>
      )}
    </div>
  );
}
