import { FilePasswordPrompt } from "./FilePasswordPrompt";
/* oxlint-disable react/no-array-index-key -- Read-only cells retain their database row and column positions. */
import { decodeFilePreviewText, filePreviewKind } from "@t3tools/shared/filePreview";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { ChevronLeftIcon, ChevronRightIcon, FileIcon, FolderIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { m } from "~/i18n/messages";

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
  compareArchiveRows,
  formatArchiveModifiedDate,
  SQLITE_PAGE_SIZE,
  type BinaryWorkerRequest,
  type BinaryWorkerResult,
} from "./binaryPreviewProtocol";
import { archiveImageUrl } from "./archiveImageUrl";
import { PreviewImage } from "./PreviewImage";
import { readBinaryPreview } from "./readBinaryPreview";
import { previewErrorText, previewFailureText } from "./previewFailureMessages";

const SourcePreview = lazy(() => import("./ReadOnlySourcePreview"));
type Archive = Extract<BinaryWorkerResult, { type: "archive" }>;
type Database = Extract<BinaryWorkerResult, { type: "sqlite" }>;
type Rows = Extract<BinaryWorkerResult, { type: "rows" }>;

const rowsLabel = (count: number, gt: ReturnType<typeof useGT>) =>
  gt("{count, plural, one {{formatted} row} other {{formatted} rows}}", {
    count,
    formatted: count.toLocaleString(),
  });
const columnsLabel = (count: number, gt: ReturnType<typeof useGT>) =>
  gt("{count, plural, one {{formatted} column} other {{formatted} columns}}", {
    count,
    formatted: count.toLocaleString(),
  });
const entriesLabel = (count: number, gt: ReturnType<typeof useGT>) =>
  gt("{count, plural, one {{formatted} entry} other {{formatted} entries}}", {
    count,
    formatted: count.toLocaleString(),
  });

function ArchiveFile(props: { readonly path: string; readonly bytes: Uint8Array<ArrayBuffer> }) {
  const gt = useGT();
  const [url, setUrl] = useState<string | null>(null);
  const kind = filePreviewKind({ name: props.path });
  const text = (() => {
    if (!["text", "markdown", "html", "mermaid", "unsupported"].includes(kind)) return null;
    try {
      return decodeFilePreviewText(props.bytes);
    } catch {
      return null;
    }
  })();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Create an object URL for the extracted image and revoke it when the entry changes or unmounts.
  useEffect(() => {
    if (kind !== "image") return;
    const image = archiveImageUrl(props.path, props.bytes);
    // oxlint-disable-next-line react/set-state-in-effect -- Publish a Blob URL only after registering its cleanup.
    setUrl(image.url);
    return image.revoke;
  }, [props.bytes, props.path, kind]);
  if (kind === "image")
    return url ? <PreviewImage key={url} src={url} name={props.path} /> : <FileSurfaceLoading />;
  if (!text)
    return (
      <FileSurfaceFailure
        message={gt("Only UTF-8 text and images can be opened inside an archive.")}
      />
    );
  return (
    <>
      {text.truncated ? (
        <FileSurfaceNotice>
          <T>Preview limited to the first 1 MB.</T>
        </FileSurfaceNotice>
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
  const gt = useGT();
  const messages = useMessages();
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
  const [incorrectPassword, setIncorrectPassword] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const send = (request: BinaryWorkerRequest) => {
    setBusy(true);
    setError(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setError(m(msg("This file took too long to preview. Close it and try again.")));
      setBusy(false);
      workerRef.current?.terminate();
      workerRef.current = null;
    }, 15_000);
    workerRef.current?.postMessage(request);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the binary fetch, archive or database worker, message subscription, and request timeout for this file.
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
      () => fail(m(msg("This file took too long to preview. Close it and try again."))),
      30_000,
    );
    worker.addEventListener("error", () =>
      fail(m(msg("Could not load the file viewer. Close it and try again."))),
    );
    worker.addEventListener("message", (event: MessageEvent<BinaryWorkerResult>) => {
      if (controller.signal.aborted) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      const result = event.data;
      setBusy(false);
      if (result.type === "password") setIncorrectPassword(result.incorrect);
      else if (result.type === "error") setError(previewFailureText(result));
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
        fail(previewErrorText(cause, m(msg("Could not read this file.")))),
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
    { path: string; entryPath: string; directory: boolean; size: number; modified: string | null }
  >();
  for (const item of archive?.entries ?? []) {
    // Give directories a trailing slash so the root marker "." normalizes like "./".
    const memberPath = item.directory ? `${item.path}/` : item.path;
    const name = memberPath.replace(/^(?:\.?\/)+|\/+$/g, "").replace(/\/{2,}/g, "/");
    if (!name.startsWith(folder)) continue;
    const rest = name.slice(folder.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    const path = slash < 0 ? name : `${folder}${rest.slice(0, slash)}`;
    const directory = slash >= 0 || item.directory;
    // Files stay keyed by their raw name so `/a.txt` and `a.txt` remain two openable rows.
    const key = directory ? `d:${path}` : `f:${item.path}`;
    const previous = children.get(key);
    if (previous && directory) {
      previous.size += item.size;
      if (slash < 0 && item.directory) previous.modified = item.modified;
    } else
      children.set(key, {
        path,
        entryPath: item.path,
        directory,
        size: item.size,
        modified: item.modified,
      });
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {archive ? (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-xs">
          <FileSurfaceAction
            label={selectedPath ? gt("Back to archive") : gt("Parent folder")}
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
            {selectedPath ?? (folder || gt("Archive contents"))}
          </span>
          <span className="shrink-0 text-muted-foreground">
            {entriesLabel(archive.entries.length, gt)}
            {sizeBytes !== null ? ` · ${formatAttachmentSize(sizeBytes, messages)}` : ""}
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
                <SelectTrigger
                  aria-label={gt("Table", { $context: "noun, database table picker" })}
                  aria-disabled={busy}
                  aria-busy={busy}
                  size="xs"
                >
                  <SelectValue>
                    {table.name} ({rowsLabel(table.count, gt)})
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {database.tables.map((item) => (
                    <SelectItem key={item.name} value={item.name}>
                      {item.name} ({rowsLabel(item.count, gt)})
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <FileSurfaceAction
              label={gt("Previous rows")}
              disabled={busy || page === 0}
              onPress={() => selectPage(page - 1)}
            >
              <ChevronLeftIcon className="size-3.5" />
            </FileSurfaceAction>
            <span className="shrink-0 tabular-nums" aria-live="polite">
              {table.count === 0
                ? gt("0 rows")
                : gt("{start}–{end} of {total}", {
                    start: String(page * SQLITE_PAGE_SIZE + 1),
                    end: String(Math.min(table.count, (page + 1) * SQLITE_PAGE_SIZE)),
                    total: table.count.toLocaleString(),
                  })}
            </span>
            <FileSurfaceAction
              label={gt("Next rows")}
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
            {rowsLabel(table.count, gt)} ·{" "}
            {rows ? columnsLabel(rows.columns.length, gt) : gt("… columns")}
            {sizeBytes !== null ? ` · ${formatAttachmentSize(sizeBytes, messages)}` : ""}
          </div>
          <FileSurfaceNotice>
            <T>
              Read-only. Up to 50 columns and 1,024 characters per cell. Blob contents are omitted.
            </T>
          </FileSurfaceNotice>
        </>
      ) : null}
      {incorrectPassword !== null ? (
        <FilePasswordPrompt
          incorrect={incorrectPassword}
          onSubmit={(password) => {
            setIncorrectPassword(null);
            send({ type: "unlock", password });
          }}
        />
      ) : error ? (
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
            aria-label={gt("Archive entries")}
            className="w-full border-separate border-spacing-0 text-xs"
          >
            <thead className="sticky top-0 bg-background text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-normal">
                  <T $context="column header, file name">Name</T>
                </th>
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  <T $context="column header, file size">Size</T>
                </th>
                <th scope="col" className="px-3 py-2 text-right font-normal">
                  <T $context="column header, last modified date">Modified</T>
                </th>
              </tr>
            </thead>
            <tbody>
              {[...children.values()].sort(compareArchiveRows).map((item) => (
                <tr
                  key={item.directory ? `d:${item.path}` : `f:${item.entryPath}`}
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
                          send({ type: "entry", path: item.entryPath });
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
                    {formatAttachmentSize(item.size, messages)}
                  </td>
                  <td className="w-28 border-b border-border/60 px-3 py-2 text-right whitespace-nowrap text-muted-foreground">
                    {formatArchiveModifiedDate(item.modified)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {children.size === 0 ? (
            <p className="p-6 text-xs text-muted-foreground">
              <T>This folder is empty.</T>
            </p>
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
            <p className="p-6 text-xs text-muted-foreground">
              <T>This table is empty.</T>
            </p>
          ) : null}
        </div>
      ) : (
        <p className="p-6 text-xs text-muted-foreground">
          <T>This database has no readable tables.</T>
        </p>
      )}
    </div>
  );
}
