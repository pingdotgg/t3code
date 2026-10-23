import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import {
  ArrowLeftIcon,
  DownloadIcon,
  EyeOffIcon,
  FileArchiveIcon,
  LayoutGridIcon,
  ListTreeIcon,
  MessageSquarePlusIcon,
  Trash2Icon,
} from "lucide-react";
import { LegendList } from "@legendapp/list/react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { MiddleTruncate } from "~/components/ui/middle-truncate";
import { toastManager } from "~/components/ui/toast";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useComposerHandleContext } from "~/composerHandleContext";
import { useTheme } from "~/hooks/useTheme";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import {
  loadZipPreview,
  readZipPreviewResponse,
  ZipPreviewError,
  type ZipPreviewEntry,
} from "~/lib/zipPreview";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";

import { AttachmentFilePreview, ReadOnlySourcePreview } from "./AttachmentFilePreview";
import { useZipFileCounts } from "./filePreviewMode";
import {
  FILE_SURFACE_SUBHEADER_CLASS,
  FileSurfaceAction,
  FileSurfaceLoading,
} from "./fileSurfaceChrome";

type ZipArchive = Awaited<ReturnType<typeof loadZipPreview>>;
type ZipFailureReason = ZipPreviewError["reason"];

const MIB = 1024 * 1024;
const ZIP_TREE_UNSAFE_CSS = `${PIERRE_TREE_UNSAFE_CSS}
  [data-item-flattened-subitem]:not(:last-child) { opacity: 0.6; flex-shrink: 100; min-width: 0; overflow: hidden; }`;

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
}

function folderOf(path: string) {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

function ZipState(props: {
  readonly title: string;
  readonly description: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <Empty size="compact" role="alert">
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
      {props.children ? (
        <EmptyContent>
          <div className="flex flex-wrap justify-center gap-2">{props.children}</div>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

function archiveFailureCopy(reason: ZipFailureReason | null, message: string) {
  switch (reason) {
    case "encrypted":
      return {
        title: "This ZIP is password-protected",
        description: "T3 Code can't open encrypted ZIPs. Save it and open it with its password.",
      };
    case "archive-limit":
    case "entry-limit":
      return {
        title: "Too large to browse here",
        description:
          "Browsing works up to 32 MB and 2,000 files so the panel stays fast. Save the ZIP to open it locally.",
      };
    case "unsupported":
      return { title: "This ZIP format isn't supported", description: message };
    case null:
      return { title: "Couldn't load this ZIP", description: message };
    default:
      return {
        title: "Couldn't read this ZIP",
        description:
          "It may be incomplete or not a real ZIP. Try again, or ask for the file again.",
      };
  }
}

function ZipEntryFailure(props: {
  readonly entry: ZipPreviewEntry;
  readonly reason: ZipFailureReason | null;
  readonly message: string;
  readonly onShowPrefix: () => void;
  readonly onSave: () => void;
}) {
  const kind = filePreviewKind({
    name: props.entry.name,
    mimeType: props.entry.mimeType ?? "application/octet-stream",
  });
  const textLike = kind === "text" || kind === "markdown" || kind === "html";
  if (props.reason === "file-limit")
    return (
      <ZipState
        title="Too big to preview in full"
        description={`Previews stop at 10 MB.${textLike ? " You can read the start of the file or save the whole file." : " Save the file to open it."}`}
      >
        {textLike ? (
          <Button size="sm" onClick={props.onShowPrefix}>
            Show first 1 MB
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={props.onSave}>
          Save file
        </Button>
      </ZipState>
    );
  if (props.reason === "image-limit")
    return (
      <ZipState
        title="Too large to preview safely"
        description="Large images could freeze the tab, so it isn't decoded. Save it to view it in another app."
      >
        <Button size="sm" onClick={props.onSave}>
          Save file
        </Button>
      </ZipState>
    );
  return (
    <ZipState title="Couldn't read this file" description={props.message}>
      <Button size="sm" variant="outline" onClick={props.onSave}>
        Save file
      </Button>
    </ZipState>
  );
}

function ZipEntryPreview(props: {
  readonly archive: ZipArchive;
  readonly entry: ZipPreviewEntry;
  readonly header: React.ReactNode;
  readonly onSave: () => void;
}) {
  const [file, setFile] = useState<Blob | null>(null);
  const [failure, setFailure] = useState<{ reason: ZipFailureReason | null; message: string }>();
  const [prefix, setPrefix] = useState<string | null>(null);
  const [prefixRequested, setPrefixRequested] = useState(false);
  const { archive, entry } = props;
  useEffect(() => {
    const controller = new AbortController();
    const read = prefixRequested
      ? archive
          .readTextPrefix(entry, controller.signal)
          .then((result) => () => setPrefix(result.text))
      : archive.readFile(entry, controller.signal).then((blob) => () => setFile(blob));
    read.then(
      (apply) => {
        if (!controller.signal.aborted) apply();
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setFailure({
          reason: cause instanceof ZipPreviewError ? cause.reason : null,
          message: errorMessage(cause, "Could not read this file."),
        });
      },
    );
    return () => controller.abort();
  }, [archive, entry, prefixRequested]);
  const subheader = <div className={FILE_SURFACE_SUBHEADER_CLASS}>{props.header}</div>;
  if (prefix !== null)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {subheader}
        <div
          role="status"
          className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 text-2xs text-warning-foreground"
        >
          Showing the first 1 MB of {formatAttachmentSize(entry.sizeBytes)}. Save the file to read
          it in full.
        </div>
        <ReadOnlySourcePreview name={entry.name} text={prefix} />
      </div>
    );
  if (failure)
    return (
      <>
        {subheader}
        <ZipEntryFailure
          entry={entry}
          reason={failure.reason}
          message={failure.message}
          onShowPrefix={() => {
            setFailure(undefined);
            setPrefixRequested(true);
          }}
          onSave={props.onSave}
        />
      </>
    );
  if (!file)
    return (
      <>
        {subheader}
        <FileSurfaceLoading />
      </>
    );
  return (
    <AttachmentFilePreview
      name={entry.name}
      mimeType={file.type}
      sizeBytes={file.size}
      file={file}
      header={props.header}
    />
  );
}

function ZipImageTile(props: {
  readonly archive: ZipArchive;
  readonly entry: ZipPreviewEntry;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const { archive, entry } = props;
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    archive.readFile(entry, controller.signal).then(
      (blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      },
      () => {},
    );
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [archive, entry]);
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      aria-label={entry.name}
      onClick={props.onSelect}
      className="group flex w-30 flex-col gap-1.5 text-left focus-visible:outline-none"
    >
      <span
        className={cn(
          "flex size-30 items-center justify-center overflow-hidden rounded-lg bg-muted group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-inset",
          props.selected && "ring-2 ring-primary ring-inset",
        )}
      >
        {url ? (
          <img src={url} alt="" decoding="async" className="max-h-full max-w-full object-contain" />
        ) : null}
      </span>
      <span
        className={cn(
          "truncate text-2xs",
          props.selected ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {entry.name}
      </span>
    </button>
  );
}

type ZipGridRow =
  | { readonly key: string; readonly folder: string; readonly count: number }
  | { readonly key: string; readonly entries: readonly ZipPreviewEntry[] };

const GRID_TILE_STRIDE = 132;

function ZipImageGrid(props: {
  readonly archive: ZipArchive;
  readonly entries: readonly ZipPreviewEntry[];
  readonly selected: ZipPreviewEntry | null;
  readonly onSelect: (entry: ZipPreviewEntry) => void;
}) {
  const [columns, setColumns] = useState(1);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return observeResize(element, ([entry]) => {
      if (entry)
        setColumns(Math.max(1, Math.floor((entry.contentRect.width - 28 + 12) / GRID_TILE_STRIDE)));
    });
  }, []);
  const groups = new Map<string, ZipPreviewEntry[]>();
  for (const entry of props.entries) {
    const folder = folderOf(entry.path);
    const group = groups.get(folder);
    if (group) group.push(entry);
    else groups.set(folder, [entry]);
  }
  const rows: ZipGridRow[] = [];
  for (const [folder, entries] of groups) {
    rows.push({ key: `folder:${folder}`, folder, count: entries.length });
    for (let index = 0; index < entries.length; index += columns)
      rows.push({ key: `${folder}:${index}`, entries: entries.slice(index, index + columns) });
  }
  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col">
      <LegendList<ZipGridRow>
        data={rows}
        keyExtractor={(row) => row.key}
        extraData={props.selected}
        getItemType={(row) => ("folder" in row ? "folder" : "tiles")}
        renderItem={({ item: row }) =>
          "folder" in row ? (
            <h3 className="flex items-baseline gap-2 px-0.5 pt-1 pb-3 text-xs">
              <span className="font-semibold">{row.folder.replace(/\/$/, "") || "Top level"}</span>
              <span className="text-muted-foreground">
                {row.count.toLocaleString()} {row.count === 1 ? "image" : "images"}
              </span>
            </h3>
          ) : (
            <div className="flex gap-3 pb-3">
              {row.entries.map((entry) => (
                <ZipImageTile
                  key={entry.path}
                  archive={props.archive}
                  entry={entry}
                  selected={props.selected === entry}
                  onSelect={() => props.onSelect(entry)}
                />
              ))}
            </div>
          )
        }
        estimatedItemSize={154}
        drawDistance={308}
        className="min-h-0 flex-1 overscroll-contain px-3.5 pt-3.5"
      />
    </div>
  );
}

function ZipArchiveBrowser(props: {
  readonly name: string;
  readonly archive: ZipArchive;
  readonly origin: string;
  readonly sizeBytes: number;
  readonly onSaveZip: () => void;
  readonly onRemove: (() => void) | undefined;
}) {
  const { resolvedTheme } = useTheme();
  const composerRef = useComposerHandleContext();
  const [viewing, setViewing] = useState<ZipPreviewEntry | null>(null);
  const [layout, setLayout] = useState<"tree" | "grid">("tree");
  const [adding, setAdding] = useState(false);
  const extraction = useRef<AbortController | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { archive } = props;
  useEffect(() => () => extraction.current?.abort(), []);
  const occupied = new Set(archive.entries.map((entry) => entry.path));
  const files = new Map<string, ZipPreviewEntry>();
  const paths = archive.entries.map((entry) => {
    let path = entry.path;
    if (!entry.isDirectory) {
      if (occupied.has(`${path}/`)) {
        do {
          path += " (file)";
        } while (occupied.has(path) || occupied.has(`${path}/`));
        occupied.add(path);
      }
      files.set(path, entry);
    }
    return path;
  });
  const fileEntries = [...files.values()];
  const { model } = useFileTree({
    paths,
    density: "compact",
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    icons: T3_PIERRE_ICONS,
    search: false,
    fileTreeSearchMode: "hide-non-matches",
    onSelectionChange: (selectedPaths) => {
      const path = selectedPaths.at(-1);
      const entry = path ? files.get(path) : undefined;
      if (entry) {
        setViewing(entry);
        rootRef.current?.focus({ preventScroll: true });
      }
    },
    unsafeCSS: ZIP_TREE_UNSAFE_CSS,
  });
  const search = useFileTreeSearch(model);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    if (search.value !== filter) model.setSearch(filter);
  }, [filter, model, search.value]);
  const query = filter.trim().toLowerCase();
  const noMatches = query !== "" && search.matchingPaths.length === 0;
  const gridEntries =
    query === ""
      ? fileEntries
      : fileEntries.filter((entry) => entry.path.toLowerCase().includes(query));
  const goBack = () => {
    const selected = model.getSelectedPaths();
    for (const path of selected) model.getItem(path)?.deselect();
    setViewing(null);
    const path = selected.at(-1);
    if (path) model.getItem(path)?.focus();
  };
  const saveEntry = (entry: ZipPreviewEntry) => {
    const controller = new AbortController();
    archive.readFileForSave(entry, controller.signal).then(
      (blob) => saveBlob(blob, entry.name),
      (cause: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not save file",
          description: errorMessage(cause, "Please try again."),
        }),
    );
  };
  const addToChat = (entry: ZipPreviewEntry) => {
    const composer = composerRef?.current;
    if (!composer) return;
    extraction.current?.abort();
    const controller = new AbortController();
    extraction.current = controller;
    setAdding(true);
    archive.readFileForSave(entry, controller.signal).then(
      (blob) => {
        if (controller.signal.aborted) return;
        composer.addDroppedFiles([new File([blob], entry.name, { type: blob.type })]);
        setAdding(false);
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setAdding(false);
        toastManager.add({
          type: "error",
          title: "Could not add file to chat",
          description: errorMessage(cause, "Please try again."),
        });
      },
    );
  };
  const fileCountLabel = `${archive.fileCount.toLocaleString()} ${
    archive.imagesOnly
      ? archive.fileCount === 1
        ? "image"
        : "images"
      : archive.fileCount === 1
        ? "file"
        : "files"
  }`;
  const folder = viewing ? folderOf(viewing.path).replace(/\/$/, "") : "";
  const filterInput = (
    <InputGroup variant="ghost">
      <InputGroupInput
        type="search"
        name="zip-file-search"
        aria-label="Search ZIP files"
        placeholder={`Filter ${fileCountLabel}`}
        size="sm"
        spellCheck={false}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
    </InputGroup>
  );
  const noMatchState = (
    <ZipState
      title={`No files match “${filter.trim()}”`}
      description="The filter checks file names and folder paths."
    >
      <Button size="sm" variant="outline" onClick={() => setFilter("")}>
        Clear filter
      </Button>
    </ZipState>
  );
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="@container/zip flex min-h-0 min-w-0 flex-1 flex-col outline-none"
      onKeyDown={(event) => {
        if (!viewing || (event.key !== "Escape" && event.key !== "Backspace")) return;
        if ((event.target as HTMLElement).closest("input, textarea, [contenteditable=true]"))
          return;
        event.preventDefault();
        event.stopPropagation();
        goBack();
      }}
    >
      <div className={cn(FILE_SURFACE_SUBHEADER_CLASS, "h-12 min-h-12")}>
        <span className="flex size-6.5 shrink-0 items-center justify-center rounded-md bg-warning/16 text-warning">
          <FileArchiveIcon className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="min-w-0 truncate text-sm font-semibold">{props.name}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {props.origin} · {fileCountLabel}
            {props.sizeBytes > 0 ? ` · ${formatAttachmentSize(props.sizeBytes)}` : ""}
          </span>
        </span>
        <Button size="xs" variant="outline" onClick={props.onSaveZip}>
          <DownloadIcon />
          Save ZIP
        </Button>
        {props.onRemove ? (
          <FileSurfaceAction label="Remove from draft" onPress={props.onRemove}>
            <Trash2Icon className="size-3.5" />
          </FileSurfaceAction>
        ) : null}
      </div>
      {archive.entries.length === 0 ? (
        <ZipState title="This archive is empty" description="There are no files to preview." />
      ) : archive.imagesOnly && layout === "grid" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
            <div className="min-w-0 flex-1">{filterInput}</div>
            <ZipLayoutToggle layout={layout} onLayoutChange={setLayout} />
          </div>
          {gridEntries.length === 0 ? (
            noMatchState
          ) : (
            <ZipImageGrid
              archive={archive}
              entries={gridEntries}
              selected={viewing}
              onSelect={setViewing}
            />
          )}
          {viewing ? (
            <div className="flex h-13 shrink-0 items-center gap-2.5 border-t border-border bg-background pr-2.5 pl-3.5">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-xs font-medium">{viewing.name}</span>
                <span className="truncate text-2xs text-muted-foreground">
                  {[folder, formatAttachmentSize(viewing.sizeBytes)].filter(Boolean).join(" · ")}
                </span>
              </span>
              <Button size="xs" disabled={adding} onClick={() => addToChat(viewing)}>
                <MessageSquarePlusIcon />
                Add to chat
              </Button>
              <Button size="xs" variant="outline" onClick={() => setLayout("tree")}>
                Open
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col @min-[40rem]/zip:w-59 @min-[40rem]/zip:flex-none @min-[40rem]/zip:border-r @min-[40rem]/zip:border-border/60",
              viewing ? "hidden @min-[40rem]/zip:flex" : "flex",
            )}
          >
            <div className="flex shrink-0 items-center gap-2 px-2 pt-2 pb-1.5">
              <div className="min-w-0 flex-1">{filterInput}</div>
              {archive.imagesOnly ? (
                <ZipLayoutToggle layout={layout} onLayoutChange={setLayout} />
              ) : null}
            </div>
            <FileTree
              model={model}
              aria-label={`${props.name} files`}
              className={cn("min-h-0 flex-1 overflow-hidden", noMatches && "hidden")}
              style={pierreTreeStyle(resolvedTheme)}
            />
            {noMatches ? noMatchState : null}
            {archive.hiddenCount > 0 ? (
              <div className="flex shrink-0 items-center gap-1.5 border-t border-border/60 px-3.5 py-2.5 text-2xs text-muted-foreground">
                <EyeOffIcon className="size-3" />
                {archive.hiddenCount.toLocaleString()} macOS{" "}
                {archive.hiddenCount === 1 ? "file" : "files"} hidden
              </div>
            ) : null}
          </div>
          <div
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col bg-background",
              viewing ? "flex" : "hidden @min-[40rem]/zip:flex",
            )}
          >
            {viewing ? (
              <ZipEntryPreview
                key={viewing.path}
                archive={archive}
                entry={viewing}
                onSave={() => saveEntry(viewing)}
                header={
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="@min-[40rem]/zip:hidden"
                      onClick={goBack}
                      aria-label="Back to ZIP files"
                    >
                      <ArrowLeftIcon />
                    </Button>
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
                      {folder ? (
                        <span className="min-w-0 text-muted-foreground">
                          <MiddleTruncate value={`${folder}/`} />
                        </span>
                      ) : null}
                      <span className="shrink-0 font-medium">{viewing.name}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {formatAttachmentSize(viewing.sizeBytes)}
                      </span>
                    </span>
                    <Button size="xs" disabled={adding} onClick={() => addToChat(viewing)}>
                      <MessageSquarePlusIcon />
                      Add to chat
                    </Button>
                  </>
                }
              />
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-xs text-muted-foreground">
                Select a file to preview.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ZipLayoutToggle(props: {
  readonly layout: "tree" | "grid";
  readonly onLayoutChange: (layout: "tree" | "grid") => void;
}) {
  return (
    <ToggleGroup
      aria-label="ZIP layout"
      className="shrink-0"
      variant="segmented"
      value={[props.layout]}
      onValueChange={(value) => {
        const next = value[0];
        if (next === "tree" || next === "grid") props.onLayoutChange(next);
      }}
    >
      <Toggle aria-label="Tree view" value="tree">
        <ListTreeIcon className="size-3.5" />
        Tree
      </Toggle>
      <Toggle aria-label="Grid view" value="grid">
        <LayoutGridIcon className="size-3.5" />
        Grid
      </Toggle>
    </ToggleGroup>
  );
}

export default function ZipArchivePreview(props: {
  readonly name: string;
  readonly file: Blob | null;
  readonly url: string;
  readonly sizeBytes: number;
  readonly origin: string;
  readonly countKey: string | null;
  readonly onRetry: () => void;
  readonly onSaveZip: () => void;
  readonly onRemove?: () => void;
}) {
  const [archive, setArchive] = useState<ZipArchive | null>(null);
  const [failure, setFailure] = useState<{ reason: ZipFailureReason | null; message: string }>();
  const [progress, setProgress] = useState({ received: 0, seconds: 0 });
  const [cancelled, setCancelled] = useState(false);
  const download = useRef<AbortController | null>(null);
  const { file, url, countKey } = props;
  useEffect(() => {
    const controller = new AbortController();
    download.current = controller;
    const startedAt = Date.now();
    void (async () => {
      const blob =
        file ??
        (await readZipPreviewResponse(
          await fetch(url, { signal: controller.signal }),
          controller.signal,
          (received) => setProgress({ received, seconds: (Date.now() - startedAt) / 1000 }),
        ));
      const loaded = await loadZipPreview(blob, controller.signal);
      if (controller.signal.aborted) return;
      if (countKey) useZipFileCounts.setState({ [countKey]: loaded.fileCount });
      setArchive(loaded);
    })().catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setFailure({
        reason: cause instanceof ZipPreviewError ? cause.reason : null,
        message: errorMessage(cause, "Could not read this ZIP."),
      });
    });
    return () => controller.abort();
  }, [file, url, countKey]);

  const saveZip = (
    <Button size="sm" variant="outline" onClick={props.onSaveZip}>
      Save ZIP
    </Button>
  );
  if (cancelled)
    return (
      <ZipState
        title="Download canceled"
        description="The file list appears after the ZIP downloads."
      >
        <Button size="sm" onClick={props.onRetry}>
          Try again
        </Button>
        {saveZip}
      </ZipState>
    );
  if (failure) {
    const copy = archiveFailureCopy(failure.reason, failure.message);
    const retryable = failure.reason === null || failure.reason === "invalid";
    return (
      <ZipState title={copy.title} description={copy.description}>
        {retryable ? (
          <Button size="sm" onClick={props.onRetry}>
            Try again
          </Button>
        ) : null}
        {saveZip}
      </ZipState>
    );
  }
  if (!archive) {
    if (file) return <FileSurfaceLoading />;
    const total = props.sizeBytes;
    const { received, seconds } = progress;
    const fraction = total > 0 ? Math.min(1, received / total) : 0;
    const secondsLeft =
      received > 0 && total > received
        ? Math.ceil(((total - received) / received) * seconds)
        : null;
    return (
      <div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center px-6">
        <div className="flex w-full max-w-xs flex-col gap-2">
          <p className="text-sm">
            <span className="font-semibold tabular-nums">{(received / MIB).toFixed(1)} MB</span>
            {total > 0 ? (
              <span className="text-muted-foreground"> of {formatAttachmentSize(total)}</span>
            ) : null}
          </p>
          <div
            role="progressbar"
            aria-label="ZIP download progress"
            aria-valuemin={0}
            aria-valuemax={total || undefined}
            aria-valuenow={received}
            className="h-1 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-primary" style={{ width: `${fraction * 100}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            Downloading the ZIP so its files can be listed.
            {secondsLeft !== null ? ` About ${secondsLeft} seconds left.` : ""}
          </p>
          <Button
            size="xs"
            variant="outline"
            className="self-start"
            onClick={() => {
              download.current?.abort();
              setCancelled(true);
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <ZipArchiveBrowser
      name={props.name}
      archive={archive}
      origin={props.origin}
      sizeBytes={props.sizeBytes}
      onSaveZip={props.onSaveZip}
      onRemove={props.onRemove}
    />
  );
}
