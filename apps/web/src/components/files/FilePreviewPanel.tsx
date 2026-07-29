import { Eye, FileText, Search } from "lucide-react";
import { useEffect, useState } from "react";

import type { ScopedThreadRef } from "@t3tools/contracts";

import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import { readEnvironmentApi } from "~/environmentApi";
import { getEnvironmentHttpBaseUrl } from "~/environments/runtime";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

export function FilePreviewPanel(props: {
  readonly cwd: string;
  readonly relativePath: string | null;
  readonly threadRef: ScopedThreadRef;
  readonly onOpenFile: (relativePath: string) => void;
}) {
  const [contents, setContents] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<ReadonlyArray<{ readonly path: string }>>([]);
  const openPreview = useAtomCommand(previewEnvironment.open);
  const api = readEnvironmentApi(props.threadRef.environmentId);

  useEffect(() => {
    const normalizedQuery = query.trim();
    if (!api || props.relativePath || normalizedQuery.length === 0) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    void api.projects
      .searchEntries({
        scope: { _tag: "thread", threadId: props.threadRef.threadId },
        query: normalizedQuery,
        limit: 100,
      })
      .then(
        (result) => {
          if (!cancelled) setEntries(result.entries.filter((entry) => entry.kind === "file"));
        },
        () => {
          if (!cancelled) setEntries([]);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [api, props.relativePath, props.threadRef.threadId, query]);

  useEffect(() => {
    if (!props.relativePath || !api || isBrowserPreviewFile(props.relativePath)) {
      setContents(null);
      setError(null);
      return;
    }
    let cancelled = false;
    void api.projects
      .readFile({ threadId: props.threadRef.threadId, relativePath: props.relativePath })
      .then(
        (result) => {
          if (!cancelled) {
            setContents(result.contents);
            setError(null);
          }
        },
        (cause: unknown) => {
          if (!cancelled) {
            setContents(null);
            setError(cause instanceof Error ? cause.message : "Unable to read file.");
          }
        },
      );
    return () => {
      cancelled = true;
    };
  }, [api, props.relativePath, props.threadRef.threadId]);

  if (!props.relativePath) {
    return (
      <section className="flex h-full min-h-0 flex-col" data-right-panel-files-surface>
        <label className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
          <Search className="size-4 text-muted-foreground" />
          <input
            aria-label="Search workspace files"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search files"
            value={query}
          />
        </label>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => props.onOpenFile(entry.path)}
            >
              <FileText className="size-4 shrink-0" />
              <span className="truncate">{entry.path}</span>
            </button>
          ))}
          {entries.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No workspace files found.</p>
          ) : null}
        </div>
      </section>
    );
  }

  const relativePath = props.relativePath;
  const httpBaseUrl = getEnvironmentHttpBaseUrl(props.threadRef.environmentId);
  const openInBrowser =
    isPreviewSupportedInRuntime() && isBrowserPreviewFile(relativePath) && api && httpBaseUrl
      ? () =>
          void openFileInPreview({
            threadRef: props.threadRef,
            relativePath,
            httpBaseUrl,
            createAssetUrl: api.assets.createUrl,
            openPreview,
          })
      : null;

  return (
    <section className="flex h-full min-h-0 flex-col" data-right-panel-file-surface>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <FileText className="size-4" />
        <span className="min-w-0 flex-1 truncate">{props.relativePath}</span>
        {openInBrowser ? (
          <button type="button" className="rounded p-1 hover:bg-accent" onClick={openInBrowser}>
            <Eye className="size-4" />
            <span className="sr-only">Open in browser</span>
          </button>
        ) : null}
      </header>
      <pre className="min-h-0 flex-1 overflow-auto p-4 text-xs">
        {error ??
          contents ??
          (isBrowserPreviewFile(relativePath)
            ? "Open this file in the browser preview."
            : "Loading file...")}
      </pre>
    </section>
  );
}
