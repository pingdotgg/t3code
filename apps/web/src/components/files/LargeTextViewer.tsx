import { useEffect, useImperativeHandle, useRef, useState, type RefObject } from "react";
import { parseDelimitedPreview } from "@t3tools/shared/delimitedPreview";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { useClientSettings } from "~/hooks/useSettings";
import { FileSurfaceFailure, FileSurfaceLoading, FileSurfaceNotice } from "./fileSurfaceChrome";
import { PREVIEW_PAGE_ROWS, type TextPreviewResult } from "./largeTextProtocol";
import VirtualTablePreview from "./VirtualTablePreview";

const FIRST_SCREEN_BYTES = 16 * 1024;

function firstScreen(text: string, delimiter: "," | "\t" | null, complete: boolean) {
  if (!text || text.includes("\0")) return [];
  const rows = delimiter
    ? parseDelimitedPreview(text, delimiter, {
        maxRows: PREVIEW_PAGE_ROWS * 2 + 1,
        maxColumns: 1024,
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
}) {
  const [meta, setMeta] = useState<Extract<TextPreviewResult, { type: "meta" }> | null>(null);
  const [pages, setPages] = useState(new Map<number, string[][]>());
  const [error, setError] = useState<string | null>(null);
  const worker = useRef<Worker | null>(null);
  const copyPending = useRef<{
    resolve: (text: string) => void;
    reject: (cause: Error) => void;
  } | null>(null);
  const pending = useRef(new Set<number>());
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  // oxlint-disable-next-line t3code/react-effect-budget -- Own the prefix fetch and indexing worker, cancelling requests and pending copies when the source changes or unmounts.
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
      const rows = firstScreen(text, props.delimiter, complete);
      if (!rows.length) return;
      prefetched = true;
      setPages(
        new Map(
          [0, PREVIEW_PAGE_ROWS]
            .filter((start) => start < rows.length)
            .map((start) => [
              start / PREVIEW_PAGE_ROWS,
              rows.slice(start, start + PREVIEW_PAGE_ROWS),
            ]),
        ),
      );
      setMeta({
        type: "meta",
        count: rows.length,
        columns: rows.reduce((max, row) => Math.max(max, row.length), 1),
        complete: false,
      });
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
          copyPending.current?.reject(new Error(result.message));
          copyPending.current = null;
          if (result.operation !== "copy") setError(result.message);
        } else if (result.type === "meta") {
          indexed = true;
          if (prefetched) {
            setPages(new Map());
            pending.current.clear();
            prefetched = false;
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
        copyPending.current?.reject(new Error("The text viewer stopped."));
        copyPending.current = null;
        setError("Could not load the text viewer. Close the file and try again.");
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
    if (props.sizeBytes === 0) {
      startWorker();
    } else if (props.text !== undefined) {
      paintFirstScreen(
        props.text.slice(0, FIRST_SCREEN_BYTES),
        props.text.length <= FIRST_SCREEN_BYTES,
      );
      scheduleWorker();
    } else if (props.src) {
      void fetch(props.src, {
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
          paintFirstScreen(await response.text(), total <= FIRST_SCREEN_BYTES);
        })
        .catch(() => {
          // The worker reports authorization, network and format failures.
        })
        .finally(scheduleWorker);
    } else startWorker();
    return () => {
      controller.abort();
      copyPending.current?.reject(new Error("Preview closed."));
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
          reject(new Error("The file is unavailable."));
          return;
        }
        if (copyPending.current) {
          reject(new Error("Another copy is in progress."));
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
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-1 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground tabular-nums"
        role="status"
      >
        {Math.max(0, meta.count - (props.delimiter && meta.count ? 1 : 0)).toLocaleString()}{" "}
        {props.delimiter ? "rows" : "lines"}
        {props.delimiter ? ` · ${meta.count ? meta.columns.toLocaleString() : 0} columns` : ""}
        {meta.complete && meta.sizeBytes !== undefined
          ? ` · ${meta.sizeBytes === 0 ? "0 bytes" : formatAttachmentSize(meta.sizeBytes)}`
          : " · Indexing…"}
      </div>
      {!meta.complete ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20">
          <FileSurfaceNotice>Loading the rest of the file…</FileSurfaceNotice>
        </div>
      ) : null}
      {meta.columns === 1024 ? (
        <FileSurfaceNotice>
          Showing the first 1,024 columns. Source and Save retain every column.
        </FileSurfaceNotice>
      ) : null}
      {meta.count > 0 ? (
        <VirtualTablePreview
          name={props.name}
          count={meta.count}
          columns={meta.columns}
          header={header}
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
        <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted-foreground">
          This file is empty.
        </div>
      )}
    </div>
  );
}
