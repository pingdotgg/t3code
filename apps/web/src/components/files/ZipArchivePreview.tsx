import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { MiddleTruncate } from "~/components/ui/middle-truncate";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { loadZipPreview, readZipPreviewResponse, type ZipPreviewEntry } from "~/lib/zipPreview";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";

import { AttachmentFilePreview } from "./AttachmentFilePreview";
import {
  FILE_SURFACE_SUBHEADER_CLASS,
  FileSurfaceFailure,
  FileSurfaceLoading,
  FileSurfaceNotice,
} from "./fileSurfaceChrome";

type ZipArchive = Awaited<ReturnType<typeof loadZipPreview>>;

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

function ZipEntryPreview(props: { readonly archive: ZipArchive; readonly entry: ZipPreviewEntry }) {
  const [file, setFile] = useState<Blob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { archive, entry } = props;
  useEffect(() => {
    const controller = new AbortController();
    archive.readFile(entry, controller.signal).then(
      (blob) => {
        if (!controller.signal.aborted) setFile(blob);
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause, "Could not read this file."));
      },
    );
    return () => controller.abort();
  }, [archive, entry]);
  if (error) return <FileSurfaceFailure message={error} />;
  if (!file) return <FileSurfaceLoading />;
  return (
    <AttachmentFilePreview
      name={entry.name}
      mimeType={file.type}
      sizeBytes={file.size}
      file={file}
      origin="ZIP"
    />
  );
}

function ZipArchiveBrowser(props: { readonly name: string; readonly archive: ZipArchive }) {
  const { resolvedTheme } = useTheme();
  const [viewing, setViewing] = useState<ZipPreviewEntry | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const { paths, files } = useMemo(() => {
    const occupied = new Set(props.archive.entries.map((entry) => entry.path));
    const files = new Map<string, ZipPreviewEntry>();
    const paths = props.archive.entries.map((entry) => {
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
    return { paths, files };
  }, [props.archive]);
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
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  const search = useFileTreeSearch(model);
  const goBack = () => {
    const selected = model.getSelectedPaths();
    for (const path of selected) model.getItem(path)?.deselect();
    setViewing(null);
    const path = selected.at(-1);
    if (path) model.getItem(path)?.focus();
  };
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
      <div className={FILE_SURFACE_SUBHEADER_CLASS}>
        {viewing ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={goBack}
            aria-label="Back to ZIP files"
          >
            <ArrowLeftIcon />
            Files
          </Button>
        ) : (
          <span className="text-xs font-medium">Files</span>
        )}
        <span className="flex min-w-0 flex-1 text-xs text-muted-foreground">
          <MiddleTruncate value={viewing?.path ?? props.name} />
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {files.size.toLocaleString()} {files.size === 1 ? "file" : "files"}
        </span>
      </div>
      {props.archive.entries.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-xs text-muted-foreground">
          This archive is empty.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col @min-[40rem]/zip:w-60 @min-[40rem]/zip:flex-none @min-[40rem]/zip:border-r @min-[40rem]/zip:border-border/60",
              viewing ? "hidden @min-[40rem]/zip:flex" : "flex",
            )}
          >
            <div className="shrink-0 p-2">
              <InputGroup variant="ghost">
                <InputGroupInput
                  type="search"
                  name="zip-file-search"
                  aria-label="Search ZIP files"
                  placeholder="Search files"
                  size="sm"
                  spellCheck={false}
                  value={search.value}
                  onChange={(event) => search.setValue(event.target.value)}
                />
              </InputGroup>
            </div>
            <FileTree
              model={model}
              aria-label={`${props.name} files`}
              className="min-h-0 flex-1 overflow-hidden"
              style={pierreTreeStyle(resolvedTheme)}
            />
          </div>
          <div
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col",
              viewing ? "flex" : "hidden @min-[40rem]/zip:flex",
            )}
          >
            {viewing ? (
              <ZipEntryPreview key={viewing.path} archive={props.archive} entry={viewing} />
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

export default function ZipArchivePreview(props: {
  readonly name: string;
  readonly file: Blob | null;
  readonly url: string;
  readonly onRetry: () => void;
}) {
  const [archive, setArchive] = useState<ZipArchive | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { file, url } = props;
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const blob =
        file ??
        (await readZipPreviewResponse(
          await fetch(url, { signal: controller.signal }),
          controller.signal,
        ));
      const loaded = await loadZipPreview(blob, controller.signal);
      if (!controller.signal.aborted) setArchive(loaded);
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(cause, "Could not read this ZIP."));
    });
    return () => controller.abort();
  }, [file, url]);

  if (error) return <FileSurfaceFailure message={error} onRetry={props.onRetry} />;
  if (!archive)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {file ? null : (
          <FileSurfaceNotice>Files appear after the full ZIP has downloaded.</FileSurfaceNotice>
        )}
        <FileSurfaceLoading />
      </div>
    );
  return <ZipArchiveBrowser name={props.name} archive={archive} />;
}
