import type { TimestampFormat } from "@workbench/contracts/settings";
import type { TurnId } from "@workbench/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Code2Icon,
  ExternalLinkIcon,
  EyeIcon,
  FileSearchIcon,
  FolderOpenIcon,
  Maximize2Icon,
  Minimize2Icon,
  PencilIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { buildWorkspaceBreadcrumbSegments } from "../../filePathDisplay";
import { formatTimestamp } from "../../timestampFormat";
import { describeWorkspaceArtifact, type WorkspaceArtifact } from "../../workspaceArtifacts";
import DocumentMarkdown from "./DocumentMarkdown";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";

/**
 * Below this pane width the breadcrumb/action row collapses the per-action
 * buttons (Open in app, Open in editor, Add to chat) into a single overflow
 * menu so labels don't overlap. The threshold is conservative — we'd rather
 * show the menu a little earlier than have buttons collide.
 */
const VIEWER_NARROW_THRESHOLD_PX = 420;

function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState<number>(0);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    setWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function statusToneClass(status: WorkspaceArtifact["status"]) {
  switch (status) {
    case "Created":
      return "text-emerald-400";
    case "Removed":
      return "text-rose-400";
    case "Moved":
    case "Moved and updated":
      return "text-amber-400";
    default:
      return "text-blue-400";
  }
}

function WorkspaceBreadcrumb(props: {
  path: string;
  workspaceRoot: string | undefined;
  onOpen: () => void;
}) {
  const segments = useMemo(
    () => buildWorkspaceBreadcrumbSegments(props.path, props.workspaceRoot),
    [props.path, props.workspaceRoot],
  );
  const filename = segments.at(-1) ?? "No file selected";
  const leadingSegments = segments.slice(0, -1);

  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="flex min-w-0 max-w-full items-center gap-1.5 text-left text-sm text-foreground/90 transition-colors hover:text-blue-400"
      title="Open file in its native app"
    >
      {leadingSegments.length > 0 ? (
        <>
          <span
            dir="rtl"
            className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground/72"
          >
            {leadingSegments.join(" / ")}
          </span>
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/55" />
        </>
      ) : null}
      <span className="shrink-0 truncate font-medium text-foreground/92">{filename}</span>
    </button>
  );
}

export type ViewerDocumentMode = "preview" | "source" | "edit";

/**
 * Categories where the viewer offers an in-place Edit mode (textarea-backed
 * source editing). Code files are intentionally excluded — they're better
 * edited in a real editor (the "Open in editor" action in the viewer header).
 */
const EDITABLE_CATEGORIES = new Set(["note", "document", "data"]);

interface ViewerPaneProps {
  workspaceRoot: string | undefined;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  selectedPath: string | null;
  selectedArtifact: WorkspaceArtifact | null;
  documentViewMode: ViewerDocumentMode;
  documentText: string | null;
  documentTextTruncated: boolean;
  documentTextLoading: boolean;
  patchPreview: string | null;
  selectedDocumentTextSelection: string;
  onSetDocumentViewMode: (mode: ViewerDocumentMode) => void;
  onRefresh: () => void;
  onOpenInApp: (path: string) => void;
  onOpenInEditor: (path: string) => void;
  onSyncSelection: () => void;
  onClearSelection: () => void;
  onAddSelectionToChat: () => void;
  onOpenWorkspaceFileLink: (path: string) => boolean;
  onOpenTurnDiff: ((turnId: TurnId, filePath?: string) => void) | undefined;
  onClosePane: () => void;
  /**
   * When true, the rail itself is in its expanded (chat-covering) state.
   * Drives the maximize/minimize button's visual + label. Optional — when
   * unset, the expand control is hidden entirely.
   */
  expanded?: boolean;
  onToggleExpanded?: (() => void) | undefined;
  /**
   * Persists the edited file contents back to disk. Resolved promise = success
   * (the viewer exits edit mode and toasts); rejected = error (viewer stays
   * in edit mode with the unsaved buffer intact). Optional — when unset, the
   * Edit affordance is hidden.
   */
  onSaveFile?: (input: { path: string; contents: string }) => Promise<void>;
}

export function ViewerPane({
  workspaceRoot,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  selectedPath,
  selectedArtifact,
  documentViewMode,
  documentText,
  documentTextTruncated,
  documentTextLoading,
  patchPreview,
  selectedDocumentTextSelection,
  onSetDocumentViewMode,
  onRefresh,
  onOpenInApp,
  onOpenInEditor,
  onSyncSelection,
  onAddSelectionToChat,
  onOpenWorkspaceFileLink,
  onOpenTurnDiff,
  onClosePane,
  expanded = false,
  onToggleExpanded,
  onSaveFile,
}: ViewerPaneProps) {
  const documentSelectionContainerRef = useRef<HTMLDivElement | null>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [paneRootRef, paneWidth] = useElementWidth<HTMLDivElement>();
  const isNarrow = paneWidth > 0 && paneWidth < VIEWER_NARROW_THRESHOLD_PX;

  const selectedDescriptor = useMemo(
    () => (selectedPath ? describeWorkspaceArtifact(selectedPath) : null),
    [selectedPath],
  );
  const supportsCodeView = selectedDescriptor?.previewKind === "text";
  const isEditableCategory = selectedDescriptor
    ? EDITABLE_CATEGORIES.has(selectedDescriptor.category)
    : false;
  const supportsEdit = !!onSaveFile && supportsCodeView && isEditableCategory && !!selectedPath;
  const quickEditDisabledReason = documentTextLoading
    ? "Loading file contents"
    : documentTextTruncated
      ? "Open the full file in your editor before editing"
      : null;
  const canEnterEditMode = supportsEdit && quickEditDisabledReason === null;

  // ----- edit-mode buffer + dirty tracking -----
  // `editBuffer` is null when not editing. Once the user enters edit mode we
  // seed it from the on-disk text and let them mutate it freely. Dirty = the
  // buffer has diverged from the on-disk text we last loaded.
  const [editBuffer, setEditBuffer] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const editBaselineRef = useRef<string>("");

  // If the on-disk text reloads (refresh, file change) WHILE we're editing,
  // we keep the user's buffer — surprising them by clobbering edits is worse
  // than letting them resolve a conflict manually with Save.
  // If the user isn't editing, no buffer to keep in sync with.
  // (Intentionally no effect here.)

  const isDirty = editBuffer !== null && editBuffer !== editBaselineRef.current;

  const activeDocumentViewMode: ViewerDocumentMode = supportsCodeView
    ? documentViewMode
    : "preview";

  const handleOpenInApp = useCallback(() => {
    if (!selectedPath) return;
    onOpenInApp(selectedPath);
  }, [onOpenInApp, selectedPath]);

  const handleOpenInEditor = useCallback(() => {
    if (!selectedPath) return;
    onOpenInEditor(selectedPath);
  }, [onOpenInEditor, selectedPath]);

  const selectedDocumentContent = documentText ?? patchPreview ?? null;

  // ----- edit-mode callbacks -----
  const enterEditMode = useCallback(() => {
    if (!supportsEdit) return;
    const seed = documentText ?? "";
    editBaselineRef.current = seed;
    setEditBuffer(seed);
    onSetDocumentViewMode("edit");
  }, [documentText, onSetDocumentViewMode, supportsEdit]);

  const exitEditMode = useCallback(() => {
    setEditBuffer(null);
    editBaselineRef.current = "";
    onSetDocumentViewMode("preview");
  }, [onSetDocumentViewMode]);

  const cancelEdits = useCallback(() => {
    if (isDirty && typeof window !== "undefined" && !window.confirm("Discard unsaved changes?")) {
      return;
    }
    exitEditMode();
  }, [exitEditMode, isDirty]);

  const saveEdits = useCallback(async () => {
    if (!onSaveFile || !selectedPath || editBuffer === null) return;
    setIsSaving(true);
    try {
      await onSaveFile({ path: selectedPath, contents: editBuffer });
      // Bake the saved value in as the new baseline so a subsequent re-edit
      // doesn't think the file is still dirty.
      editBaselineRef.current = editBuffer;
      setEditBuffer(null);
      onSetDocumentViewMode("preview");
    } catch {
      // Parent surfaces the error via toast; we just stay in edit mode so the
      // user doesn't lose their buffer.
    } finally {
      setIsSaving(false);
    }
  }, [editBuffer, onSaveFile, onSetDocumentViewMode, selectedPath]);

  // If the user navigates to a different file while editing, drop the buffer
  // so the new file doesn't open in edit mode with stale text.
  useEffect(() => {
    setEditBuffer(null);
    editBaselineRef.current = "";
  }, [selectedPath]);

  useEffect(() => {
    if (activeDocumentViewMode !== "edit" || editBuffer === null) {
      return;
    }
    editTextareaRef.current?.focus();
    editTextareaRef.current?.setSelectionRange(0, 0);
  }, [activeDocumentViewMode, editBuffer]);

  return (
    <div
      ref={paneRootRef}
      className="flex h-full min-h-0 min-w-0 flex-col [-webkit-app-region:no-drag]"
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3 [-webkit-app-region:no-drag]">
        <div className="flex min-w-0 items-center gap-1.5">
          <Button
            size="xs"
            variant={activeDocumentViewMode === "preview" ? "secondary" : "ghost"}
            onClick={() => {
              if (activeDocumentViewMode === "edit" && !isDirty) {
                exitEditMode();
              } else {
                onSetDocumentViewMode("preview");
              }
            }}
            disabled={activeDocumentViewMode === "edit" && isDirty}
            className="gap-1.5"
            title={
              activeDocumentViewMode === "edit" && isDirty
                ? "Save or discard your edits first"
                : "Preview"
            }
          >
            <EyeIcon className="size-3.5" />
            Preview
          </Button>
          <Button
            size="xs"
            variant={activeDocumentViewMode === "source" ? "secondary" : "ghost"}
            onClick={() => onSetDocumentViewMode("source")}
            disabled={!supportsCodeView || (activeDocumentViewMode === "edit" && isDirty)}
            className="gap-1.5"
            title={
              activeDocumentViewMode === "edit" && isDirty
                ? "Save or discard your edits first"
                : "View raw source"
            }
          >
            <Code2Icon className="size-3.5" />
            Source
          </Button>
          {supportsEdit ? (
            activeDocumentViewMode === "edit" ? (
              // While editing, the Quick edit button slot becomes Save/Cancel
              // so the controls live next to the mode toggles instead of
              // floating in a footer the user has to scroll to find.
              <>
                <span className="mx-1 text-[11px] text-muted-foreground/65">
                  {isDirty ? "Unsaved" : "No changes"}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={cancelEdits}
                  disabled={isSaving}
                  className="gap-1.5"
                  title="Discard edits"
                >
                  Cancel
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => {
                    void saveEdits();
                  }}
                  disabled={!isDirty || isSaving}
                  className="gap-1.5"
                  title="Save changes to disk"
                >
                  {isSaving ? "Saving\u2026" : "Save"}
                </Button>
              </>
            ) : (
              <Button
                size="xs"
                variant="outline"
                onClick={enterEditMode}
                disabled={!canEnterEditMode}
                className="gap-1.5"
                title={quickEditDisabledReason ?? "Quick edit this file inline"}
              >
                <PencilIcon className="size-3.5" />
                Quick edit
              </Button>
            )
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onRefresh}
            aria-label="Refresh viewer"
            title="Refresh viewer"
            className="text-muted-foreground/60 hover:text-foreground/80"
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          {onToggleExpanded ? (
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={onToggleExpanded}
              aria-label={expanded ? "Shrink viewer" : "Expand viewer"}
              title={expanded ? "Shrink viewer" : "Expand viewer to cover the chat column"}
              className="text-muted-foreground/60 hover:text-foreground/80"
            >
              {expanded ? (
                <Minimize2Icon className="size-3.5" />
              ) : (
                <Maximize2Icon className="size-3.5" />
              )}
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={onClosePane}
            aria-label="Close viewer pane"
            title="Close viewer pane"
            className="text-muted-foreground/50 hover:text-foreground/80"
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border/60 px-4 py-3 [-webkit-app-region:no-drag]">
        <div className="min-w-0">
          {selectedPath ? (
            <WorkspaceBreadcrumb
              path={selectedPath}
              workspaceRoot={workspaceRoot}
              onOpen={handleOpenInApp}
            />
          ) : (
            <p className="truncate text-sm font-medium text-foreground/90">No file selected</p>
          )}
          {selectedDescriptor ? (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground/68">
              <span>{selectedDescriptor.typeLabel}</span>
              {selectedArtifact ? (
                <>
                  <span className={statusToneClass(selectedArtifact.status)}>
                    {selectedArtifact.status}
                  </span>
                  <span>{formatTimestamp(selectedArtifact.completedAt, timestampFormat)}</span>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        {selectedPath ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {selectedDocumentTextSelection ? (
              <Button size="xs" variant="secondary" onClick={onAddSelectionToChat}>
                Add to chat
              </Button>
            ) : null}
            <ShowInFolderSplitButton
              compact={isNarrow}
              onShowInFolder={handleOpenInApp}
              onOpenInEditor={handleOpenInEditor}
            />
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1">
        {!selectedPath ? (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground/72">
            Select a file from the workspace to preview it here.
          </div>
        ) : activeDocumentViewMode === "edit" && editBuffer !== null ? (
          // ----- Quick edit mode: textarea-backed source editor.
          // Save/Cancel live in the toolbar above (next to the Quick edit
          // button slot), so the body is just the textarea filling the pane. -----
          <textarea
            ref={editTextareaRef}
            aria-label="Edit file contents"
            value={editBuffer}
            onChange={(event) => setEditBuffer(event.target.value)}
            spellCheck={false}
            className={cn(
              "h-full w-full resize-none border-0 bg-background/40 px-5 py-4 font-mono text-[13px] leading-6 text-foreground/92",
              "outline-none focus-visible:bg-background/60",
            )}
            placeholder="Type to edit. Save commits to disk; Cancel discards."
          />
        ) : selectedDescriptor?.previewKind === "text" ? (
          <ScrollArea className="h-full">
            <div
              ref={documentSelectionContainerRef}
              className="space-y-3 p-4"
              onMouseUp={onSyncSelection}
              onKeyUp={onSyncSelection}
            >
              {documentTextLoading ? (
                <div className="rounded-2xl border border-border/55 bg-background/55 p-4 text-sm text-muted-foreground/72">
                  Loading document preview...
                </div>
              ) : selectedDocumentContent ? (
                activeDocumentViewMode === "preview" && selectedDescriptor.category === "note" ? (
                  <div className="rounded-2xl border border-border/55 bg-background/70 px-6 py-5">
                    <DocumentMarkdown
                      cwd={markdownCwd}
                      text={selectedDocumentContent}
                      onOpenWorkspaceFile={onOpenWorkspaceFileLink}
                    />
                  </div>
                ) : (
                  <div className="rounded-2xl border border-border/55 bg-background/70 p-4">
                    <pre
                      className={cn(
                        "overflow-x-auto whitespace-pre-wrap text-foreground/88",
                        activeDocumentViewMode === "source"
                          ? "font-mono text-[12px] leading-6"
                          : "text-sm leading-7",
                      )}
                    >
                      {selectedDocumentContent}
                    </pre>
                  </div>
                )
              ) : (
                <div className="rounded-2xl border border-border/55 bg-background/55 p-4 text-sm text-muted-foreground/72">
                  This file does not have a text preview yet.
                </div>
              )}
              {documentTextTruncated ? (
                <div className="rounded-xl border border-border/50 bg-background/50 px-3 py-2 text-xs text-muted-foreground/70">
                  Preview truncated for speed. Open the file in your editor for the full contents.
                </div>
              ) : null}
              {selectedArtifact?.turnId && onOpenTurnDiff ? (
                <div className="flex justify-end">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => onOpenTurnDiff(selectedArtifact.turnId!, selectedPath)}
                  >
                    <FileSearchIcon className="size-3.5" />
                    Inspect changes
                  </Button>
                </div>
              ) : null}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex h-full items-center justify-center p-6">
            <div className="max-w-md rounded-2xl border border-border/55 bg-background/60 p-5">
              <div className="flex items-start gap-3">
                <div className="rounded-xl border border-border/50 bg-card/80 p-2">
                  <VscodeEntryIcon
                    pathValue={selectedPath}
                    kind="file"
                    theme={resolvedTheme}
                    className="size-5 text-muted-foreground/80"
                  />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground/88">
                    This file opens best in its native app
                  </p>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground/72">
                    Use Open in app for the native viewer or Open in editor if you need the source
                    directly.
                  </p>
                  <div className="mt-4 flex gap-2">
                    <Button size="xs" variant="outline" onClick={handleOpenInApp}>
                      <ExternalLinkIcon className="size-3.5" />
                      Show in folder
                    </Button>
                    <Button size="xs" variant="ghost" onClick={handleOpenInEditor}>
                      Open in editor
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ----- Show-in-Folder split-button -----
//
// Default click reveals the file in the OS file manager (matches what the
// breadcrumb does). The chevron opens a menu of secondary destinations:
// today that's "Open in editor", but the menu is the future home for export
// targets (Google Drive, etc.) when those connectors land.

interface ShowInFolderSplitButtonProps {
  compact: boolean;
  onShowInFolder: () => void;
  onOpenInEditor: () => void;
}

function ShowInFolderSplitButton({
  compact,
  onShowInFolder,
  onOpenInEditor,
}: ShowInFolderSplitButtonProps) {
  return (
    <div className="inline-flex items-stretch overflow-hidden rounded-md border border-border/70 bg-background/60">
      <button
        type="button"
        onClick={onShowInFolder}
        aria-label="Show in folder"
        title="Reveal this file in your file manager"
        className={cn(
          "flex items-center gap-1.5 px-2.5 text-xs font-medium text-foreground/85 transition-colors",
          "hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none",
          compact ? "py-1" : "py-1",
        )}
      >
        <FolderOpenIcon className="size-3.5 text-muted-foreground/75" />
        {compact ? null : <span>Show in folder</span>}
      </button>
      <span aria-hidden="true" className="w-px self-stretch bg-border/65" />
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="More export destinations"
              title="Other ways to open or export this file"
              className={cn(
                "flex items-center px-1.5 text-foreground/70 transition-colors",
                "hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none",
              )}
            />
          }
        >
          <ChevronDownIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-[12rem]">
          <MenuItem onClick={onOpenInEditor}>Open in editor</MenuItem>
          <MenuItem onClick={onShowInFolder}>Show in folder</MenuItem>
          {/* Future: Google Drive, Notion, email, … land here as connector
              cards are added to the workspace. */}
        </MenuPopup>
      </Menu>
    </div>
  );
}
