import { Spinner } from "~/components/ui/spinner";
import {
  AuthPreviewOperateScope,
  type EditorId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { filePreviewDelimiter } from "@t3tools/shared/delimitedPreview";
import { AuthFilesystemWriteScope } from "@t3tools/contracts";
import {
  isWorkspaceAudioPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspaceFontPreviewPath,
  isWorkspaceVideoPreviewPath,
  officePreviewKind,
  binaryPreviewKind,
} from "@t3tools/shared/filePreview";
import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { File } from "@pierre/diffs/react";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { useFilesystemReadAccess } from "~/state/filesystem";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { FolderTree, Globe2, WrapTextIcon } from "lucide-react";
import { Code2, Eye, Table2 } from "lucide";
import * as Schema from "effect/Schema";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import { OpenInPicker } from "~/components/chat/OpenInPicker";
import { MorphIcon } from "~/components/MorphIcon";
import { useRemoteOpenState } from "~/remoteOpen";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import type { ChatFileAttachment } from "~/types";
import { isHostPath } from "@t3tools/shared/path";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { ScrollArea } from "~/components/ui/scroll-area";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { type DraftId } from "~/composerDraftStore";
import { assetEnvironment } from "~/state/assets";
import { usePreviewAvailable } from "~/browser/previewRuntime";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { AttachmentFilePreview } from "./AttachmentFilePreview";
import { isPdfPreviewFile } from "./BrowserDocumentFrame";
import { DelimitedTablePreview } from "./DelimitedTablePreview";
import FileBrowserPanel from "./FileBrowserPanel";
import { FileExplorerPane } from "./FileExplorerPane";
import { FileBreadcrumbs } from "./FileBreadcrumbs";
import { breadcrumbPathOf, retainedBreadcrumbTrail, trailChildOf } from "./filePath";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import { FILE_SURFACE_SUBHEADER_CLASS, FileSurfaceAction, FileSurfaceLoading } from "./fileSurfaceChrome";
import SourceFilePreview from "./ReadOnlySourcePreview";
import { projectFileCacheKey } from "./fileContentRevision";
import { filePreviewReadErrorMessage, isMarkdownPreviewFile, resolveFilePreviewPath, setMarkdownTaskChecked, shouldShowFileExplorer } from "./filePreviewMode";
import { changeFileSaveSession, useFileSaveSession } from "./fileSaveSessions";
import { revisionedQuery } from "~/state/revisionedQuery";
import { getOptimisticProjectFileQueryData, getProjectFileQueryAtom, setProjectFileQueryData, useProjectFileQuery } from "./projectFilesQueryState";
import { EditableFileSurface, type EditableFileSurfaceProps, useFileLineReveal } from "./filePreviewEditable";
export * from "./filePreviewEditable";

import {
  WorkspaceAudioPreview,
  WorkspaceBrowserPreview,
  WorkspaceImagePreview,
  WorkspaceLargeTextPreview,
  WorkspaceVideoPreview,
} from "./filePreviewMedia";
export * from "./filePreviewMedia";

const NO_FILE_REVISION_ATOM = Atom.make(null);

interface FilePreviewPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  relativePath: string | null;
  attachment?: ChatFileAttachment;
  threadRef: ScopedThreadRef;
  composerDraftTarget: ScopedThreadRef | DraftId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInShortcutEnabled: boolean;
  revealLine: number | null;
  revealRequestId: number;
  onOpenFile: (relativePath: string) => void;
  onNavigateFolder: (relativePath: string, folderTrail: string, keepSource: boolean) => void;
  /** Retained descendant breadcrumb path after navigating up; see navigateFolder. */
  folderTrail: string | undefined;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  selectedFilePending: boolean;
  workspaceMutationId: string | null;
}

const MermaidFilePreview = lazy(() =>
  import("./MermaidFilePreview").then((module) => ({ default: module.MermaidFilePreview })),
);

const FILE_EXPLORER_STORAGE_KEY = "t3code.fileExplorerOpen";
const RENDER_MARKDOWN_STORAGE_KEY = "t3code.renderMarkdown";
const RENDER_BROWSER_FILE_STORAGE_KEY = "t3code.renderBrowserFile";
const RENDER_TABLE_STORAGE_KEY = "t3code.renderTable";
function RenderedMarkdownSurface({
  environmentId,
  cwd,
  relativePath,
  contents,
  threadRef,
  workspaceMutationId,
  readOnly,
  onPendingChange,
}: Omit<
  EditableFileSurfaceProps,
  | "resolvedTheme"
  | "composerDraftTarget"
  | "revealLine"
  | "revealRequestId"
  | "wordWrap"
  | "onPostRender"
> & {
  threadRef: ScopedThreadRef;
  readOnly: boolean;
  workspaceMutationId: string | null;
}) {
  const saveTarget = { environmentId, cwd, relativePath };
  useFileSaveSession(saveTarget, onPendingChange);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <FileMarkdownPreview
        text={contents}
        cwd={cwd}
        relativePath={relativePath}
        threadRef={threadRef}
        workspaceMutationId={workspaceMutationId}
        onTaskListChange={
          readOnly
            ? undefined
            : ({ markerOffset, checked }) => {
                const currentContents =
                  getOptimisticProjectFileQueryData(environmentId, cwd, relativePath)?.contents ??
                  contents;
                const nextContents = setMarkdownTaskChecked(currentContents, markerOffset, checked);
                if (nextContents === currentContents) return;
                setProjectFileQueryData(environmentId, cwd, relativePath, nextContents);
                changeFileSaveSession(saveTarget, nextContents);
              }
        }
      />
    </ScrollArea>
  );
}

function renderedToggleLabel(
  mode: "markdown" | "mermaid" | "html" | "table",
  rendered: boolean,
): string {
  if (mode === "mermaid") return rendered ? "Show Mermaid source" : "Show rendered diagram";
  if (mode === "markdown") return rendered ? "Show markdown source" : "Show rendered markdown";
  if (mode === "table") return rendered ? "Show source" : "Show table";
  return rendered ? "Show HTML source" : "Show rendered page";
}

function initialExplorerOpen(): boolean {
  try {
    return getLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, Schema.Boolean) ?? true;
  } catch (error) {
    console.error(error);
    return true;
  }
}

export default function FilePreviewPanel({
  environmentId,
  cwd,
  projectName,
  relativePath: requestedPath,
  attachment,
  threadRef,
  composerDraftTarget,
  keybindings,
  availableEditors,
  openInShortcutEnabled,
  revealLine,
  revealRequestId,
  onOpenFile,
  onNavigateFolder,
  folderTrail,
  onPendingChange,
  selectedFilePending,
  workspaceMutationId,
}: FilePreviewPanelProps) {
  const relativePath =
    attachment === undefined ? resolveFilePreviewPath(requestedPath, cwd) : requestedPath;
  const draft = typeof composerDraftTarget === "string";
  const { resolvedTheme } = useTheme();
  const defaultWordWrap = useClientSettings((settings) => settings.wordWrap);
  const [wordWrapOverride, setWordWrapOverride] = useState<boolean | null>(null);
  const wordWrap = wordWrapOverride ?? defaultWordWrap;
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const remoteOpenState = useRemoteOpenState(environmentId);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const previewAvailable = usePreviewAvailable(environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const isVideo = relativePath !== null && isWorkspaceVideoPreviewPath(relativePath);
  const isAudio = relativePath !== null && !isVideo && isWorkspaceAudioPreviewPath(relativePath);
  const isImage = relativePath !== null && !isVideo && isWorkspaceImagePreviewPath(relativePath);
  const isMedia = isImage || isVideo || isAudio;
  const isPdf = relativePath !== null && isPdfPreviewFile(relativePath);
  const isDocument =
    relativePath !== null &&
    (binaryPreviewKind({ name: relativePath }) !== null ||
      officePreviewKind({ name: relativePath }) !== null ||
      isWorkspaceFontPreviewPath(relativePath));
  const isHtml = relativePath !== null && !isPdf && isBrowserPreviewFile(relativePath);
  const isHostFile =
    attachment !== undefined || (relativePath !== null && isHostPath(relativePath));
  const fileAccess = useFilesystemReadAccess(environmentId);
  const { canReadFiles } = fileAccess;
  const canWriteFiles = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const file = useProjectFileQuery(
    environmentId,
    cwd,
    relativePath,
    attachment === undefined && relativePath !== null,
  );
  const [fileRefreshRevision, setFileRefreshRevision] = useState(0);
  const attemptedPath = file.readError?.resolvedPath ?? file.readError?.operationPath;
  // Folder links fail file reads; retain mutation refresh to detect conversion to files. Host folders own
  // roots; folderTrail keeps descendants.
  const breadcrumbPath =
    attachment !== undefined ? null : (relativePath ?? (folderTrail === undefined ? null : ""));
  // Reset crumbs when a host trail reaches the workspace root and no longer passes through the current path.
  const breadcrumbTrail =
    breadcrumbPath === null ? null : retainedBreadcrumbTrail(folderTrail, breadcrumbPath);
  // A trail implies a folder before reads settle, preventing file-preview flashes while navigating up.
  const isFolder =
    attachment === undefined &&
    (file.isNotFile || (folderTrail !== undefined && file.data === null && file.error === null));
  const hostFolderPath = isFolder && isHostFile ? relativePath : null;
  // A chat-linked folder reads as a file until its read settles, and revealing a
  // folder selects it in its parent instead of opening it, so reveal waits.
  const revealsInFileManager =
    !isFolder &&
    (file.data !== null || file.error !== null) &&
    serverConfig?.shellRevealInFileManager === true;
  // Everything preview-related keys off previewPath; a folder has no preview.
  const previewPath = isFolder ? null : relativePath;
  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen);
  const showExplorer = shouldShowFileExplorer({
    relativePath: previewPath,
    explorerOpen,
    attachmentOpen: attachment !== undefined,
  });
  const [renderMarkdownPreferred, setRenderMarkdownPreferred] = useLocalStorage(
    RENDER_MARKDOWN_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [renderBrowserFilePreferred, setRenderBrowserFilePreferred] = useLocalStorage(
    RENDER_BROWSER_FILE_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  const [renderTablePreferred, setRenderTablePreferred] = useLocalStorage(
    RENDER_TABLE_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  // Reveal ids restart at one per file; pair with the path so dismissal cannot swallow another file's reveal.
  const [handledReveal, setHandledReveal] = useState<{ path: string; requestId: number } | null>(
    null,
  );
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const isMarkdown = previewPath ? isMarkdownPreviewFile(previewPath) : false;
  const isMermaid = previewPath !== null && /\.(mmd|mermaid)$/i.test(previewPath);
  const [renderMermaidPreferred, setRenderMermaidPreferred] = useLocalStorage(
    "t3code.renderMermaid",
    true,
    Schema.Boolean,
  );
  const tableDelimiter =
    previewPath && attachment === undefined ? filePreviewDelimiter({ name: previewPath }) : null;
  const revealHandled =
    revealLine === null ||
    (handledReveal?.path === relativePath && handledReveal.requestId === revealRequestId);
  const renderMarkdown = isMarkdown && renderMarkdownPreferred && revealHandled;
  const renderMermaid = isMermaid && renderMermaidPreferred && revealHandled;
  const renderBrowserFile = isPdf || (isHtml && renderBrowserFilePreferred && revealHandled);
  const renderTable = tableDelimiter !== null && renderTablePreferred && revealHandled;
  const renderedMode = isMermaid
    ? ("mermaid" as const)
    : isMarkdown
      ? ("markdown" as const)
      : tableDelimiter
        ? ("table" as const)
        : isHtml
          ? ("html" as const)
          : null;
  const canToggleRendered =
    previewPath !== null && attachment === undefined && renderedMode !== null;
  const showsRawText =
    previewPath !== null &&
    file.data !== null &&
    !(isMarkdown && renderMarkdown) &&
    !renderMermaid &&
    !(tableDelimiter && renderTable) &&
    !renderBrowserFile &&
    !isDocument;
  const rendered = isMermaid
    ? renderMermaid
    : isMarkdown
      ? renderMarkdown
      : tableDelimiter
        ? renderTable
        : renderBrowserFile;
  const setRenderedPreferred = isMermaid
    ? setRenderMermaidPreferred
    : isMarkdown
      ? setRenderMarkdownPreferred
      : tableDelimiter
        ? setRenderTablePreferred
        : setRenderBrowserFilePreferred;
  const canOpenInBrowser =
    canOperatePreview &&
    previewPath !== null &&
    attachment === undefined &&
    !isVideo &&
    previewAvailable &&
    isBrowserPreviewFile(previewPath);
  // Navigating up preserves the file tab; retain the trail's path spelling to find its folder tab.
  const navigateToFolder = (crumbPath: string) => {
    const path =
      breadcrumbTrail !== null && breadcrumbPathOf(breadcrumbTrail) === crumbPath
        ? breadcrumbTrail
        : crumbPath;
    onNavigateFolder(path, retainedBreadcrumbTrail(breadcrumbTrail ?? undefined, path), !isFolder);
  };
  const absolutePath =
    breadcrumbPath === ""
      ? cwd
      : relativePath && attachment === undefined
        ? resolvePathLinkTarget(relativePath, cwd)
        : null;
  const onFilePostRender = useFileLineReveal(relativePath, revealLine, revealRequestId);
  // Mounting the file read under the workspace mutation id refetches it after each mutation.
  useAtomMount(
    canReadFiles &&
      attachment === undefined &&
      relativePath !== null &&
      // Skip mutation reads for media and documents; folders still detect conversion to files.
      (isFolder || (!isMedia && !isPdf && !isDocument)) &&
      !selectedFilePending
      ? revisionedQuery(
          getProjectFileQueryAtom(environmentId, cwd, relativePath),
          workspaceMutationId,
        )
      : NO_FILE_REVISION_ATOM,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the breadcrumb DOM so the deepest and current crumbs are in view after commit
  useEffect(() => {
    const crumbs = breadcrumbRef.current?.querySelectorAll<HTMLElement>("[data-file-crumb]");
    // Show the deepest crumb when it fits, but never at the cost of the current one.
    crumbs?.[crumbs.length - 1]?.scrollIntoView({ block: "nearest", inline: "end" });
    breadcrumbRef.current
      ?.querySelector<HTMLElement>("[data-current-file-crumb='true']")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new path or trail re-renders the crumbs, so the current one scrolls back into view.
  }, [breadcrumbPath, breadcrumbTrail]);

  const toggleExplorer = () => {
    setExplorerOpen((current) => {
      const next = !current;
      try {
        setLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, next, Schema.Boolean);
      } catch (error) {
        console.error(error);
      }
      return next;
    });
  };

  const handleOpenInBrowser = () => {
    if (!canReadFiles || !canOperatePreview || !absolutePath || !environmentHttpBaseUrl) return;
    void (async () => {
      const result = await openFileInPreview({
        threadRef,
        filePath: absolutePath,
        workspaceRoot: cwd,
        httpBaseUrl: environmentHttpBaseUrl,
        createAssetUrl,
        openPreview,
      });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open file in browser",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    })();
  };

  if (attachment === undefined && !canReadFiles) {
    if (fileAccess.isPending) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Checking file access...
        </div>
      );
    }
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {fileAccess.error ?? "This connection cannot read host files."}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {breadcrumbPath !== null && breadcrumbTrail !== null ? (
        <div className={FILE_SURFACE_SUBHEADER_CLASS} data-surface-subheader>
          <ScrollArea
            radius="none"
            ref={breadcrumbRef}
            hideScrollbars
            scrollFade
            className="min-w-0 flex-1"
            data-file-breadcrumbs
          >
            <div className="flex h-full w-max min-w-full items-center text-xs">
              <FileBreadcrumbs
                cwd={cwd}
                environmentId={environmentId}
                onNavigateFolder={navigateToFolder}
                onOpenFile={onOpenFile}
                projectName={projectName}
                relativePath={breadcrumbPath}
                trail={breadcrumbTrail}
                workspaceMutationId={workspaceMutationId}
              />
            </div>
          </ScrollArea>
          {absolutePath &&
          (environmentId === primaryEnvironmentId || remoteOpenState.mode !== "local-exec") ? (
            <OpenInPicker
              environmentId={environmentId}
              keybindings={keybindings}
              availableEditors={availableEditors}
              enableShortcut={openInShortcutEnabled}
              openInCwd={absolutePath}
              openInCwdIsFile={file.isFile}
              compact
              revealFileManager={revealsInFileManager}
            />
          ) : null}
          {canToggleRendered && renderedMode ? (
            <FileSurfaceAction
              label={renderedToggleLabel(renderedMode, rendered)}
              pressed={rendered}
              onPress={() => {
                const pressed = !rendered;
                setRenderedPreferred(pressed);
                setHandledReveal(
                  pressed && relativePath !== null
                    ? { path: relativePath, requestId: revealRequestId }
                    : null,
                );
              }}
            >
              <MorphIcon
                className="size-3.5"
                icon={rendered ? Code2 : renderedMode === "table" ? Table2 : Eye}
              />
            </FileSurfaceAction>
          ) : null}
          {showsRawText ? (
            <FileSurfaceAction
              label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
              pressed={wordWrap}
              onPress={() => setWordWrapOverride(!wordWrap)}
            >
              <WrapTextIcon className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
          {canOpenInBrowser ? (
            <FileSurfaceAction label="Open file in preview browser" onPress={handleOpenInBrowser}>
              <Globe2 className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
          {!isHostFile && previewPath !== null ? (
            <FileSurfaceAction
              label={explorerOpen ? "Hide file explorer" : "Show file explorer"}
              pressed={explorerOpen}
              onPress={toggleExplorer}
            >
              <FolderTree className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
        </div>
      ) : null}
      {relativePath && !attachment && !isHostFile && !canWriteFiles && !fileAccess.isPending ? (
        <div className="shrink-0 border-b px-3 py-1.5 text-2xs text-muted-foreground">
          Read-only connection. Unsaved edits are kept until write access returns.
        </div>
      ) : null}
      {previewPath &&
      attachment === undefined &&
      !isMedia &&
      !renderBrowserFile &&
      file.data?.truncated &&
      (draft || isMarkdown || isMermaid || isHtml) ? (
        <div className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 text-2xs text-warning-foreground">
          Preview limited to the first 1 MB of a {file.data.byteLength.toLocaleString()} byte file.
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn("min-w-0 flex-1 flex-col overflow-hidden", previewPath ? "flex" : "hidden")}
        >
          {isFolder ? null : relativePath && attachment ? (
            <AttachmentFilePreview
              key={`${environmentId}:${attachment.id}`}
              name={attachment.name}
              mimeType={attachment.mimeType}
              sizeBytes={attachment.sizeBytes}
              asset={{ environmentId, attachmentId: attachment.id }}
              htmlRender={attachment.htmlRender === true}
              threadRef={threadRef}
            />
          ) : relativePath && isVideo && absolutePath ? (
            <WorkspaceVideoPreview
              key={`${environmentId}:${threadRef.threadId}:${absolutePath}`}
              environmentId={environmentId}
              threadRef={threadRef}
              draft={draft}
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              name={relativePath}
              workspaceMutationId={workspaceMutationId}
            />
          ) : relativePath && isAudio && absolutePath ? (
            <WorkspaceAudioPreview
              key={`${environmentId}:${threadRef.threadId}:${absolutePath}`}
              environmentId={environmentId}
              threadRef={threadRef}
              draft={draft}
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              name={relativePath}
              workspaceMutationId={workspaceMutationId}
            />
          ) : relativePath && isImage && absolutePath ? (
            <WorkspaceImagePreview
              key={absolutePath}
              environmentId={environmentId}
              threadRef={threadRef}
              draft={draft}
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              alt={relativePath}
              workspaceMutationId={workspaceMutationId}
            />
          ) : relativePath && renderBrowserFile && absolutePath ? (
            <WorkspaceBrowserPreview
              key={absolutePath}
              environmentId={environmentId}
              threadRef={threadRef}
              draft={draft}
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              title={relativePath}
              workspaceMutationId={workspaceMutationId}
            />
          ) : relativePath &&
            absolutePath &&
            file.data?.truncated &&
            !isDocument &&
            !draft &&
            !isMarkdown &&
            !isMermaid &&
            !isHtml ? (
            <WorkspaceLargeTextPreview
              key={`${absolutePath}:${renderTable}:${fileRefreshRevision}`}
              environmentId={environmentId}
              threadRef={threadRef}
              absolutePath={absolutePath}
              name={relativePath}
              delimiter={renderTable ? tableDelimiter : null}
              workspaceMutationId={workspaceMutationId}
              revealLine={revealLine}
              revealRequestId={revealRequestId}
              wordWrap={wordWrap}
            />
          ) : relativePath &&
            absolutePath &&
            (isDocument || file.readError?.failure === "binary_file") ? (
            <AttachmentFilePreview
              key={`${environmentId}:${absolutePath}:${workspaceMutationId}:${fileRefreshRevision}`}
              name={relativePath.split(/[\\/]/).at(-1) || relativePath}
              mimeType="application/octet-stream"
              sizeBytes={0}
              asset={{
                environmentId,
                resource:
                  draft && isDocument
                    ? { _tag: "draft-workspace-file", cwd, path: absolutePath }
                    : {
                        _tag: "media-file",
                        threadId: threadRef.threadId,
                        path: absolutePath,
                        ...(isDocument ? {} : { disposition: "attachment" as const }),
                      },
              }}
              origin="File"
            />
          ) : relativePath && file.error && file.data === null ? (
            <div
              role="alert"
              className="scrollbar-gutter-both flex min-h-0 flex-1 flex-col overflow-auto"
            >
              <div className="my-auto flex shrink-0 flex-col gap-3 px-6 py-6 text-center text-xs leading-relaxed">
                <p className="text-destructive">
                  {file.readError ? filePreviewReadErrorMessage(file.readError) : file.error}
                </p>
                {attemptedPath ? (
                  <p className="text-muted-foreground">
                    Attempted path
                    <code className="block break-all font-mono text-foreground select-all">
                      {attemptedPath}
                    </code>
                  </p>
                ) : null}
                {!isHostFile ? (
                  <p className="text-muted-foreground">
                    Workspace folder:{" "}
                    <code className="break-all font-mono select-all">
                      {file.readError?.cwd ?? cwd}
                    </code>
                    . Check the link's path or locate the file in Files.
                  </p>
                ) : null}
              </div>
            </div>
          ) : relativePath && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
              <Spinner size="lg" />
            </div>
          ) : relativePath && file.data ? (
            renderMermaid ? (
              <Suspense fallback={<FileSurfaceLoading />}>
                <MermaidFilePreview text={file.data.contents} />
              </Suspense>
            ) : isMarkdown && renderMarkdown ? (
              <RenderedMarkdownSurface
                key={relativePath}
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                threadRef={threadRef}
                contents={file.data.contents}
                workspaceMutationId={workspaceMutationId}
                readOnly={file.data.truncated || isHostFile || !canWriteFiles}
                onPendingChange={onPendingChange}
              />
            ) : tableDelimiter && renderTable ? (
              <DelimitedTablePreview
                key={relativePath}
                name={relativePath}
                text={file.data.contents}
                delimiter={tableDelimiter}
              />
            ) : file.data.truncated || isHostFile || !canWriteFiles ? (
              <SourceFilePreview
                name={relativePath}
                text={file.data.contents}
                cacheKey={projectFileCacheKey(cwd, relativePath, file.data.contents)}
                onPostRender={onFilePostRender}
                wordWrap={wordWrap}
              />
            ) : (
              <DiffWorkerPoolProvider>
                <EditableFileSurface
                  key={`${relativePath}:${resolvedTheme}`}
                  environmentId={environmentId}
                  cwd={cwd}
                  relativePath={relativePath}
                  composerDraftTarget={composerDraftTarget}
                  contents={file.data.contents}
                  resolvedTheme={resolvedTheme}
                  revealRequestId={revealRequestId}
                  wordWrap={wordWrap}
                  onPostRender={onFilePostRender}
                  onPendingChange={onPendingChange}
                />
              </DiffWorkerPoolProvider>
            )
          ) : null}
        </div>
        {showExplorer ? (
          <FileExplorerPane resizable={Boolean(previewPath)}>
            <FileBrowserPanel
              key={`${environmentId}:${hostFolderPath ?? cwd}`}
              environmentId={environmentId}
              cwd={hostFolderPath ?? cwd}
              projectName={hostFolderPath ?? projectName}
              hostFolder={hostFolderPath !== null}
              selectedPath={
                hostFolderPath === null
                  ? relativePath
                  : trailChildOf(hostFolderPath, breadcrumbTrail ?? hostFolderPath)
              }
              selectedPathRevealId={revealRequestId}
              onOpenFile={onOpenFile}
              workspaceMutationId={workspaceMutationId}
              {...(previewPath && !isMedia && !isPdf
                ? {
                    onRefreshSelectedFile: () => {
                      if (!isDocument) file.refresh();
                      setFileRefreshRevision((value) => value + 1);
                    },
                  }
                : {})}
            />
          </FileExplorerPane>
        ) : null}
      </div>
    </div>
  );
}
