import type { EditorId, ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { Editor } from "@pierre/diffs/editor";
import { EditorProvider, File, Virtualizer } from "@pierre/diffs/react";
import {
  BookOpen,
  ChevronRight,
  Code2,
  Eye,
  FolderTree,
  LoaderCircle,
  TextWrapIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import { ensureEnvironmentApi } from "~/environmentApi";
import { getEnvironmentHttpBaseUrl } from "~/environments/runtime";
import { useTheme } from "~/hooks/useTheme";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { OpenInPicker } from "../chat/OpenInPicker";
import { DIFF_SURFACE_THEME_UNSAFE_CSS, resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { DiffWorkerPoolProvider } from "~/components/DiffWorkerPoolProvider";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import FileBrowserPanel from "./FileBrowserPanel";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import ReadOnlySourcePreview from "./ReadOnlySourcePreview";
import { projectFileCacheKey } from "./fileContentRevision";
import { fileBreadcrumbs } from "./filePath";
import { FileBreadcrumbMenu } from "./FileBreadcrumbMenu";
import { setMarkdownTaskChecked } from "./filePreviewMode";
import { getProjectFileSaveSession } from "./projectFileSaveSession";
import { resolveProjectFileQueryData, useProjectFileQuery } from "./projectFilesQueryState";

interface FilePreviewPanelProps {
  cwd: string;
  projectName?: string | undefined;
  relativePath: string | null;
  threadRef: ScopedThreadRef;
  revealLine?: number | null;
  onOpenFile: (relativePath: string) => void;
  onPendingChange?: (relativePath: string, pending: boolean) => void;
  editorPicker?: {
    keybindings: ResolvedKeybindingsConfig;
    availableEditors: ReadonlyArray<EditorId>;
  };
}

const FILE_EXPLORER_STORAGE_KEY = "t3code.fileExplorerOpen";
const FILE_WORD_WRAP_STORAGE_KEY = "t3code.filePreviewWordWrap";
const NOOP_PENDING_CHANGE = () => {};

function stripQueryAndFragment(path: string): string {
  return path.split(/[?#]/, 1)[0] ?? "";
}

function isImagePreviewFile(path: string): boolean {
  return /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp)$/i.test(stripQueryAndFragment(path));
}

function isPdfPreviewFile(path: string): boolean {
  return /\.pdf$/i.test(stripQueryAndFragment(path));
}

function isMarkdownPreviewFile(path: string): boolean {
  return /\.(?:md|markdown|mdx)$/i.test(stripQueryAndFragment(path));
}

interface EditableFileSurfaceProps {
  environmentId: ScopedThreadRef["environmentId"];
  cwd: string;
  relativePath: string;
  contents: string;
  resolvedTheme: "light" | "dark";
  onPendingChange: (relativePath: string, pending: boolean) => void;
  revealLine?: number | null;
  wordWrap: boolean;
}

function EditableFileSurface({
  environmentId,
  cwd,
  relativePath,
  contents,
  resolvedTheme,
  onPendingChange,
  revealLine = null,
  wordWrap,
}: EditableFileSurfaceProps) {
  const saveSession = useMemo(
    () => getProjectFileSaveSession(environmentId, cwd, relativePath),
    [cwd, environmentId, relativePath],
  );
  const saveState = useSyncExternalStore(saveSession.subscribe, saveSession.getSnapshot);
  const file = useProjectFileQuery(environmentId, cwd, relativePath);
  useEffect(() => {
    onPendingChange(relativePath, saveState.pending);
  }, [onPendingChange, relativePath, saveState.pending]);
  const editor = useMemo(
    () =>
      new Editor({
        onChange: (file) => {
          saveSession.change(file.contents);
        },
      }),
    [saveSession],
  );

  useEffect(
    () => () => {
      editor.cleanUp();
    },
    [editor],
  );

  // Jump to a chat-linked line through the editor's own selection scroll,
  // which resolves line geometry internally (rendered rows expose no
  // line-number selectors and code itself lives in shadow DOM). Editor lines
  // are zero-based while chat links are one-based, hence the conversion.
  // The editor throws until its text document initializes on attach, so
  // retry until it accepts the selection; afterwards it defers the scroll
  // itself until the content renders.
  useEffect(() => {
    if (revealLine == null) return;
    const line = Math.max(0, revealLine - 1);
    let cancelled = false;
    let retryTimer = 0;
    const attempt = () => {
      if (cancelled) return;
      try {
        editor.setSelections([
          {
            start: { line, character: 0 },
            end: { line, character: 0 },
            direction: "none",
          },
        ]);
      } catch (error) {
        if (error instanceof Error && /not initialized/i.test(error.message)) {
          retryTimer = window.setTimeout(attempt, 100);
          return;
        }
        throw error;
      }
    };
    const timeout = window.setTimeout(() => window.clearTimeout(retryTimer), 10_000);
    attempt();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(timeout);
    };
  }, [editor, revealLine]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {saveState.error ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-destructive/20 bg-destructive/8 px-3 py-1.5 text-[11px] text-destructive">
          <span className="min-w-0 flex-1 truncate">Save failed: {saveState.error}</span>
          <button
            type="button"
            className="shrink-0 rounded px-2 py-1 font-medium hover:bg-destructive/10"
            onClick={saveSession.retry}
          >
            Retry
          </button>
        </div>
      ) : null}
      <DiffWorkerPoolProvider>
        <EditorProvider editor={editor}>
          <Virtualizer
            className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
            config={{
              overscrollSize: 600,
              intersectionObserverMargin: 1200,
            }}
          >
            <File
              file={{
                name: relativePath,
                contents: file.data?.contents ?? contents,
                cacheKey: projectFileCacheKey(cwd, relativePath, file.data?.contents ?? contents),
              }}
              options={{
                disableFileHeader: true,
                overflow: wordWrap ? "wrap" : "scroll",
                theme: resolveDiffThemeName(resolvedTheme),
                preferredHighlighter: PREFERRED_HIGHLIGHTER,
                themeType: resolvedTheme,
                unsafeCSS: DIFF_SURFACE_THEME_UNSAFE_CSS,
              }}
              className="min-h-full"
              contentEditable
            />
          </Virtualizer>
        </EditorProvider>
      </DiffWorkerPoolProvider>
    </div>
  );
}

function RenderedMarkdownSurface({
  environmentId,
  cwd,
  relativePath,
  contents,
  threadRef,
}: {
  environmentId: ScopedThreadRef["environmentId"];
  cwd: string;
  relativePath: string;
  contents: string;
  threadRef: ScopedThreadRef;
}) {
  const saveSession = useMemo(
    () => getProjectFileSaveSession(environmentId, cwd, relativePath),
    [cwd, environmentId, relativePath],
  );

  return (
    <ScrollArea className="min-h-0 flex-1">
      <FileMarkdownPreview
        text={contents}
        cwd={cwd}
        relativePath={relativePath}
        threadRef={threadRef}
        onTaskListChange={({ markerOffset, checked }) => {
          const current =
            resolveProjectFileQueryData(environmentId, cwd, relativePath, null)?.contents ??
            contents;
          const next = setMarkdownTaskChecked(current, markerOffset, checked);
          if (next === current) return;
          saveSession.change(next);
        }}
      />
    </ScrollArea>
  );
}

type AssetUrlFactory = (input: {
  readonly resource: {
    readonly _tag: "workspace-file";
    readonly threadId: ScopedThreadRef["threadId"];
    readonly path: string;
  };
}) => Promise<{ readonly relativeUrl: string }>;

function useWorkspaceFileUrl(
  threadId: ScopedThreadRef["threadId"],
  relativePath: string | null,
  httpBaseUrl: string | null,
  createAssetUrl: AssetUrlFactory,
  enabled: boolean,
): { url: string | null; failed: boolean; pending: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled || !relativePath || !httpBaseUrl) {
      setUrl(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    void createAssetUrl({
      resource: { _tag: "workspace-file", threadId, path: relativePath },
    }).then(
      (asset) => {
        if (cancelled) return;
        try {
          setUrl(new URL(asset.relativeUrl, httpBaseUrl).toString());
        } catch {
          setFailed(true);
        }
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [createAssetUrl, enabled, httpBaseUrl, relativePath, threadId]);
  return { url, failed, pending: enabled && !!relativePath && !!httpBaseUrl && !url && !failed };
}

function WorkspaceImagePreview(props: {
  threadId: ScopedThreadRef["threadId"];
  relativePath: string;
  httpBaseUrl: string | null;
  createAssetUrl: AssetUrlFactory;
}) {
  const { url, failed, pending } = useWorkspaceFileUrl(
    props.threadId,
    props.relativePath,
    props.httpBaseUrl,
    props.createAssetUrl,
    true,
  );
  if (failed || !props.httpBaseUrl) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        Unable to load image.
      </div>
    );
  }
  if (pending || !url) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img
        className="max-h-full max-w-full object-contain"
        src={url}
        alt={props.relativePath}
        onError={(event) => {
          event.currentTarget.style.display = "none";
        }}
      />
    </div>
  );
}

function WorkspacePdfPreview(props: {
  threadId: ScopedThreadRef["threadId"];
  relativePath: string;
  httpBaseUrl: string | null;
  createAssetUrl: AssetUrlFactory;
}) {
  const { url, failed, pending } = useWorkspaceFileUrl(
    props.threadId,
    props.relativePath,
    props.httpBaseUrl,
    props.createAssetUrl,
    true,
  );
  if (failed || !props.httpBaseUrl) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        Unable to load PDF.
      </div>
    );
  }
  if (pending || !url) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }
  // The built-in PDF viewer needs an unsandboxed frame; a PDF runs no scripts.
  return (
    <iframe
      key={url}
      src={url}
      title={props.relativePath}
      className="min-h-0 flex-1 border-0 bg-white"
    />
  );
}

function initialExplorerOpen(): boolean {
  try {
    return window.localStorage.getItem(FILE_EXPLORER_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function initialWordWrap(): boolean {
  try {
    return window.localStorage.getItem(FILE_WORD_WRAP_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function FilePreviewPanel({
  threadRef,
  cwd,
  projectName: projectNameProp,
  relativePath,
  revealLine = null,
  onOpenFile,
  onPendingChange = NOOP_PENDING_CHANGE,
  editorPicker,
}: FilePreviewPanelProps) {
  const environmentId = threadRef.environmentId;
  const projectName = projectNameProp ?? cwd.split(/[\\/]/).findLast(Boolean) ?? cwd;
  const { resolvedTheme } = useTheme();
  const { copyToClipboard } = useCopyToClipboard();
  const file = useProjectFileQuery(environmentId, cwd, relativePath);
  const openPreview = useAtomCommand(previewEnvironment.open);
  const environmentApi = ensureEnvironmentApi(environmentId);
  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen);
  const [renderMarkdown, setRenderMarkdown] = useState(true);
  const [wordWrap, setWordWrap] = useState(initialWordWrap);
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const breadcrumbs = useMemo(
    () => (relativePath ? fileBreadcrumbs(projectName, relativePath) : []),
    [projectName, relativePath],
  );

  useEffect(() => {
    const currentCrumb = breadcrumbRef.current?.querySelector<HTMLElement>(
      "[data-current-file-crumb='true']",
    );
    currentCrumb?.scrollIntoView({ block: "nearest", inline: "end" });
  }, [relativePath]);

  const setExplorerOpenPersisted = (open: boolean) => {
    setExplorerOpen(open);
    try {
      window.localStorage.setItem(FILE_EXPLORER_STORAGE_KEY, String(open));
    } catch {}
  };

  const toggleExplorer = () => {
    setExplorerOpenPersisted(!explorerOpen);
  };

  const setWordWrapPersisted = (wrap: boolean) => {
    setWordWrap(wrap);
    try {
      window.localStorage.setItem(FILE_WORD_WRAP_STORAGE_KEY, String(wrap));
    } catch {}
  };

  const httpBaseUrl = getEnvironmentHttpBaseUrl(environmentId);
  const showImage = !!relativePath && isImagePreviewFile(relativePath);
  const showPdf = !!relativePath && !showImage && isPdfPreviewFile(relativePath);
  const showMarkdownToggle =
    !!relativePath && !showImage && !showPdf && isMarkdownPreviewFile(relativePath);
  const showWordWrapToggle =
    !!relativePath &&
    !showImage &&
    !showPdf &&
    !(showMarkdownToggle && renderMarkdown) &&
    file.data?.binary !== true;
  const openInBrowser =
    relativePath &&
    isPreviewSupportedInRuntime() &&
    isBrowserPreviewFile(relativePath) &&
    httpBaseUrl
      ? () =>
          void openFileInPreview({
            threadRef,
            relativePath,
            httpBaseUrl,
            createAssetUrl: environmentApi.assets.createUrl,
            openPreview,
          })
      : null;

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-chat-background"
      data-right-panel-files-surface
    >
      {relativePath ? (
        <div className="flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent">
          <ScrollArea
            ref={breadcrumbRef}
            hideScrollbars
            scrollFade
            className="min-w-0 flex-1 rounded-none"
            data-file-breadcrumbs
          >
            <div className="flex h-full w-max min-w-full items-center text-xs">
              {breadcrumbs.map((crumb, index) => (
                <div
                  key={`${crumb.kind}:${crumb.path}`}
                  className="flex min-w-0 shrink-0 items-center"
                  data-current-file-crumb={crumb.kind === "file"}
                >
                  {index > 0 ? (
                    <ChevronRight className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
                  ) : null}
                  {crumb.kind === "file" ? (
                    <button
                      type="button"
                      className="max-w-40 truncate text-foreground hover:underline"
                      title={`Copy path: ${relativePath}`}
                      aria-label={`Copy path ${relativePath}`}
                      onClick={() => copyToClipboard(relativePath, undefined)}
                    >
                      {crumb.label}
                    </button>
                  ) : (
                    <FileBreadcrumbMenu
                      environmentId={environmentId}
                      cwd={cwd}
                      path={crumb.path}
                      label={crumb.label}
                      selectedPath={relativePath}
                      theme={resolvedTheme}
                      onOpenFile={onOpenFile}
                    />
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
          {editorPicker ? (
            <OpenInPicker
              {...editorPicker}
              openInCwd={`${cwd.replace(/[\\/]$/, "")}/${relativePath}`}
              enableShortcut={false}
            />
          ) : null}
          {showMarkdownToggle ? (
            <div
              role="group"
              aria-label="Markdown view"
              className="flex shrink-0 items-center gap-px rounded-lg border border-border/60 bg-muted/40 p-0.5"
            >
              <button
                type="button"
                aria-pressed={renderMarkdown}
                title="Show rendered markdown"
                onClick={() => setRenderMarkdown(true)}
                className={cn(
                  "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                  renderMarkdown
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <BookOpen className="size-3.5" aria-hidden />
                Preview
              </button>
              <button
                type="button"
                aria-pressed={!renderMarkdown}
                title="Show markdown source"
                onClick={() => setRenderMarkdown(false)}
                className={cn(
                  "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                  renderMarkdown
                    ? "text-muted-foreground hover:text-foreground"
                    : "bg-background text-foreground shadow-sm",
                )}
              >
                <Code2 className="size-3.5" aria-hidden />
                Source
              </button>
            </div>
          ) : null}
          {showWordWrapToggle ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    className="shrink-0"
                    pressed={wordWrap}
                    onPressedChange={setWordWrapPersisted}
                    aria-label={wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
                    variant="default"
                    size="xs"
                  >
                    <TextWrapIcon className="size-3.5" />
                  </Toggle>
                }
              />
              <TooltipPopup>
                {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={explorerOpen}
                  onPressedChange={toggleExplorer}
                  aria-label={explorerOpen ? "Hide file explorer" : "Show file explorer"}
                  variant="default"
                  size="xs"
                >
                  <FolderTree className="size-3.5" />
                </Toggle>
              }
            />
            <TooltipPopup>
              {explorerOpen ? "Hide file explorer" : "Show file explorer"}
            </TooltipPopup>
          </Tooltip>
          {openInBrowser ? (
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Open in browser"
              onClick={openInBrowser}
            >
              <Eye className="size-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}
      {relativePath && file.data?.truncated && !showImage && !showPdf ? (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/8 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          Preview limited to the first 1 MB of a {(file.data.byteLength ?? 0).toLocaleString()} byte
          file.
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "min-w-0 flex-1 flex-col overflow-hidden",
            relativePath ? "flex" : "hidden",
          )}
        >
          {relativePath && openInBrowser ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
              Open this file in the browser preview.
            </div>
          ) : relativePath && file.error && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
              {file.error}
            </div>
          ) : relativePath && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : relativePath && file.data ? (
            showImage ? (
              <WorkspaceImagePreview
                threadId={threadRef.threadId}
                relativePath={relativePath}
                httpBaseUrl={httpBaseUrl}
                createAssetUrl={environmentApi.assets.createUrl}
              />
            ) : showPdf ? (
              <WorkspacePdfPreview
                threadId={threadRef.threadId}
                relativePath={relativePath}
                httpBaseUrl={httpBaseUrl}
                createAssetUrl={environmentApi.assets.createUrl}
              />
            ) : file.data.binary ? (
              <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
                This binary file cannot be previewed or edited as text.
              </div>
            ) : showMarkdownToggle && renderMarkdown ? (
              // Markdown reconciles in place across text updates, so a file
              // switch needs a new key or the previous file's disclosure and
              // task state carries into the next document.
              <RenderedMarkdownSurface
                key={`${environmentId}:${cwd}:${relativePath}`}
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                contents={file.data.contents}
                threadRef={threadRef}
              />
            ) : file.data.truncated ? (
              <ReadOnlySourcePreview
                name={relativePath}
                text={file.data.contents}
                wordWrap={wordWrap}
                cacheKey={projectFileCacheKey(cwd, relativePath, file.data.contents)}
              />
            ) : (
              <EditableFileSurface
                key={`${relativePath}:${resolvedTheme}`}
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                contents={file.data.contents}
                resolvedTheme={resolvedTheme}
                onPendingChange={onPendingChange}
                revealLine={revealLine}
                wordWrap={wordWrap}
              />
            )
          ) : null}
        </div>
        {explorerOpen || relativePath === null ? (
          <aside
            className={cn(
              "flex min-h-0 shrink-0 bg-chat-background",
              relativePath
                ? "w-[min(22rem,46%)] min-w-64 border-l border-border/60"
                : "min-w-0 flex-1",
            )}
          >
            <FileBrowserPanel
              key={`${environmentId}:${cwd}`}
              environmentId={environmentId}
              cwd={cwd}
              projectName={projectName}
              selectedPath={relativePath}
              revealRequest={null}
              onOpenFile={onOpenFile}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
