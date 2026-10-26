/* oxlint-disable react/no-array-index-key -- Read-only cells retain their database row and column positions. */
import {
  decodeFilePreviewText,
  filePreviewKind,
  hostPreviewMimeTypeFromExtension,
} from "@t3tools/shared/filePreview";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { ChevronLeftIcon, ChevronRightIcon, FileIcon, FolderIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "~/components/ui/select";

import {
  FileSurfaceAction,
  FileSurfaceFailure,
  FileSurfaceLoading,
  FileSurfaceNotice,
} from "./fileSurfaceChrome";
import {
  SQLITE_PAGE_SIZE,
  type BinaryWorkerRequest,
  type BinaryWorkerResult,
} from "./binaryPreviewProtocol";
import { PreviewImage } from "./PreviewImage";
import { readBinaryPreview } from "./readBinaryPreview";

const SourcePreview = lazy(() => import("./ReadOnlySourcePreview"));
type Archive = Extract<BinaryWorkerResult, { type: "archive" }>;
type Database = Extract<BinaryWorkerResult, { type: "sqlite" }>;
type Rows = Extract<BinaryWorkerResult, { type: "rows" }>;

function ArchiveFile(props: { readonly path: string; readonly bytes: Uint8Array<ArrayBuffer> }) {
  const [url, setUrl] = useState<string | null>(null);
  const kind = filePreviewKind({ name: props.path });
  const text = (() => {
    if (!["text", "markdown", "html", "mermaid"].includes(kind)) return null;
    try {
      return decodeFilePreviewText(props.bytes);
    } catch {
      return null;
    }
  })();
  // oxlint-disable-next-line t3code/react-effect-budget -- Create an object URL for the extracted image and revoke it when the entry changes or unmounts.
  useEffect(() => {
    if (kind !== "image") return;
    const extension = props.path.slice(props.path.lastIndexOf("."));
    const objectUrl = URL.createObjectURL(
      new Blob([props.bytes], {
        type: hostPreviewMimeTypeFromExtension(extension) ?? "application/octet-stream",
      }),
    );
    // oxlint-disable-next-line react/set-state-in-effect -- Publish a Blob URL only after registering its cleanup.
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [props.bytes, props.path, kind]);
  if (kind === "image")
    return url ? <PreviewImage key={url} src={url} name={props.path} /> : <FileSurfaceLoading />;
  if (!text)
    return (
      <FileSurfaceFailure message="Only UTF-8 text and images can be opened inside an archive." />
    );
  return (
    <>
      {text.truncated ? (
        <FileSurfaceNotice>Preview limited to the first 1 MB.</FileSurfaceNotice>
      ) : null}
      <Suspense fallback={<FileSurfaceLoading />}>
        <SourcePreview name={props.path} text={text.text} />
      </Suspense>
    </>
  );
}

export default function BinaryViewer(props: {
  readonly src: string;
  readonly name: string;
  readonly kind: "archive" | "sqlite";
  readonly onRetry?: () => void;
}) {
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  const [archive, setArchive] = useState<Archive | null>(null);
  const [database, setDatabase] = useState<Database | null>(null);
  const [rows, setRows] = useState<Rows | null>(null);
  const [entry, setEntry] = useState<Extract<BinaryWorkerResult, { type: "entry" }> | null>(null);
  const [folder, setFolder] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState("");
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const send = (request: BinaryWorkerRequest) => {
    setBusy(true);
    setError(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setError("This file took too long to preview. Close it and try again.");
      setBusy(false);
      workerRef.current?.terminate();
      workerRef.current = null;
    }, 15_000);
    workerRef.current?.postMessage(request);
  };
  // oxlint-disable-next-line t3code/react-effect-budget -- Own the binary fetch, archive or database worker, message subscription, and request timeout for this file.
  useEffect(() => {
    const controller = new AbortController();
    const worker = new Worker(new URL("./binaryPreview.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    const fail = (message: string) => {
      if (controller.signal.aborted) return;
      setError(message);
      setBusy(false);
      controller.abort();
      worker.terminate();
      workerRef.current = null;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    timerRef.current = setTimeout(
      () => fail("This file took too long to preview. Close it and try again."),
      30_000,
    );
    worker.addEventListener("error", () =>
      fail("Could not load the file viewer. Close it and try again."),
    );
    worker.addEventListener("message", (event: MessageEvent<BinaryWorkerResult>) => {
      if (controller.signal.aborted) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      const result = event.data;
      setBusy(false);
      if (result.type === "error") setError(result.message);
      else if (result.type === "archive") setArchive(result);
      else if (result.type === "entry") setEntry(result);
      else if (result.type === "rows") setRows(result);
      else {
        setDatabase(result);
        const table = result.tables[0];
        if (table) {
          setSelectedTable(table.name);
          send({ type: "rows", table: table.name, page: 0 });
        }
      }
    });
    void readBinaryPreview(props.src, controller.signal)
      .then((bytes) => {
        if (!controller.signal.aborted) {
          setSizeBytes(bytes.byteLength);
          worker.postMessage({ type: "open", name: props.name, kind: props.kind, bytes }, [bytes]);
        }
      })
      .catch((cause: unknown) =>
        fail(cause instanceof Error ? cause.message : "Could not read this file."),
      );
    return () => {
      controller.abort();
      worker.terminate();
      workerRef.current = null;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- One worker owns this keyed file and its message stream.
  }, [props.src, props.kind, props.name]);
  const table = database?.tables.find((item) => item.name === selectedTable);
  const selectPage = (next: number, name = selectedTable) => {
    setSelectedTable(name);
    setPage(next);
    setRows(null);
    send({ type: "rows", table: name, page: next });
  };
  const children = new Map<
    string,
    { path: string; directory: boolean; size: number; modified: string | null }
  >();
  for (const item of archive?.entries ?? []) {
    if (!item.path.startsWith(folder)) continue;
    const rest = item.path.slice(folder.length).replace(/\/$/, "");
    if (!rest) continue;
    const slash = rest.indexOf("/");
    const path = slash < 0 ? item.path.replace(/\/$/, "") : `${folder}${rest.slice(0, slash)}`;
    const directory = slash >= 0 || item.directory;
    const key = `${path}${directory ? "/" : ""}`;
    const previous = children.get(key);
    if (previous) previous.size += item.size;
    else children.set(key, { path, directory, size: item.size, modified: item.modified });
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {archive ? (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs">
          <FileSurfaceAction
            label={selectedPath ? "Back to archive" : "Parent folder"}
            disabled={!selectedPath && !folder}
            onPress={() => {
              setError(null);
              setEntry(null);
              if (selectedPath) setSelectedPath(null);
              else setFolder(folder.replace(/(?:[^/]+)?\/$/, ""));
            }}
          >
            <ChevronLeftIcon className="size-3.5" />
          </FileSurfaceAction>
          <span className="min-w-0 flex-1 truncate">
            {selectedPath ?? (folder || "Archive contents")}
          </span>
          <span className="shrink-0 text-muted-foreground">
            {archive.entries.length.toLocaleString()} entries
            {sizeBytes !== null ? ` · ${formatAttachmentSize(sizeBytes)}` : ""}
          </span>
        </div>
      ) : null}
      {database && table ? (
        <>
          <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1 text-xs">
            <div className="min-w-32 flex-1">
              <Select
                value={selectedTable}
                onValueChange={(value) => {
                  if (!busy && value !== null) selectPage(0, value);
                }}
              >
                <SelectTrigger aria-label="Table" aria-disabled={busy} aria-busy={busy} size="xs">
                  <SelectValue>
                    {table.name} ({table.count.toLocaleString()} rows)
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {database.tables.map((item) => (
                    <SelectItem key={item.name} value={item.name}>
                      {item.name} ({item.count.toLocaleString()} rows)
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <FileSurfaceAction
              label="Previous rows"
              disabled={busy || page === 0}
              onPress={() => selectPage(page - 1)}
            >
              <ChevronLeftIcon className="size-3.5" />
            </FileSurfaceAction>
            <span className="shrink-0 tabular-nums" aria-live="polite">
              {table.count === 0
                ? "0 rows"
                : `${page * SQLITE_PAGE_SIZE + 1}–${Math.min(table.count, (page + 1) * SQLITE_PAGE_SIZE)} of ${table.count.toLocaleString()}`}
            </span>
            <FileSurfaceAction
              label="Next rows"
              disabled={busy || (page + 1) * SQLITE_PAGE_SIZE >= table.count}
              onPress={() => selectPage(page + 1)}
            >
              <ChevronRightIcon className="size-3.5" />
            </FileSurfaceAction>
          </div>
          <div
            className="border-b border-border/60 px-3 py-2 text-xs text-muted-foreground tabular-nums"
            role="status"
          >
            {table.count.toLocaleString()} rows · {rows?.columns.length ?? "…"} columns
            {sizeBytes !== null ? ` · ${formatAttachmentSize(sizeBytes)}` : ""}
          </div>
          <FileSurfaceNotice>
            Read-only. Up to 50 columns and 1,024 characters per cell. Blob contents are omitted.
          </FileSurfaceNotice>
        </>
      ) : null}
      {error ? (
        <FileSurfaceFailure
          message={error}
          {...(props.onRetry ? { onRetry: props.onRetry } : {})}
        />
      ) : busy ? (
        <FileSurfaceLoading />
      ) : selectedPath ? (
        entry ? (
          <ArchiveFile key={entry.path} path={entry.path} bytes={entry.bytes} />
        ) : null
      ) : archive ? (
        <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto">
          <table
            aria-label="Archive entries"
            className="w-full border-separate border-spacing-0 text-xs"
          >
            <thead className="sticky top-0 bg-background text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  Name
                </th>
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  Size
                </th>
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  Modified
                </th>
              </tr>
            </thead>
            <tbody>
              {[...children.values()]
                .sort(
                  (a, b) =>
                    Number(b.directory) - Number(a.directory) || a.path.localeCompare(b.path),
                )
                .map((item) => (
                  <tr
                    key={`${item.path}${item.directory ? "/" : ""}`}
                    className="hover:bg-muted/40"
                  >
                    <td className="max-w-0 border-b border-border/60">
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:text-primary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        onClick={() => {
                          if (item.directory) setFolder(`${item.path}/`);
                          else {
                            setSelectedPath(item.path);
                            setEntry(null);
                            send({ type: "entry", path: item.path });
                          }
                        }}
                      >
                        {item.directory ? (
                          <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate">{item.path.slice(folder.length)}</span>
                      </button>
                    </td>
                    <td className="w-20 border-b border-border/60 px-3 py-2 text-right whitespace-nowrap text-muted-foreground tabular-nums">
                      {formatAttachmentSize(item.size)}
                    </td>
                    <td className="w-28 border-b border-border/60 px-3 py-2 text-right whitespace-nowrap text-muted-foreground">
                      {item.modified ? new Date(item.modified).toLocaleDateString() : "-"}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          {children.size === 0 ? (
            <p className="p-6 text-xs text-muted-foreground">This folder is empty.</p>
          ) : null}
        </div>
      ) : rows ? (
        <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-auto">
          <table
            aria-label={`${props.name}: ${rows.table}`}
            className="min-w-full border-separate border-spacing-0 text-xs"
          >
            <thead className="sticky top-0 bg-background">
              <tr>
                {rows.columns.map((name) => (
                  <th
                    key={name}
                    scope="col"
                    className="border-r border-b border-border/60 px-3 py-2 text-left font-medium whitespace-nowrap"
                  >
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.rows.map((row, index) => (
                <tr key={index} className="even:bg-muted/30">
                  {row.map((cell, column) => (
                    <td
                      key={column}
                      className="max-w-80 min-w-32 border-r border-b border-border/60 px-3 py-1.5 align-top whitespace-pre-wrap break-words tabular-nums"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.rows.length === 0 ? (
            <p className="p-6 text-xs text-muted-foreground">This table is empty.</p>
          ) : null}
        </div>
      ) : (
        <p className="p-6 text-xs text-muted-foreground">This database has no readable tables.</p>
      )}
    </div>
  );
}
