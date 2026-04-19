import { parsePatchFiles } from "@pierre/diffs";
import { type FileDiffMetadata } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import type { EnvironmentId, ProjectEntry, ThreadId, TurnId } from "@workbench/contracts";
import type { TimestampFormat } from "@workbench/contracts/settings";
import {
  FilesIcon,
  HistoryIcon,
  ListChecksIcon,
  Maximize2Icon,
  Minimize2Icon,
  PanelRightCloseIcon,
  PlusIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { buildWorkspaceFileTree, type WorkspaceTreeNode } from "../../lib/workspaceFileTree";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { buildPatchCacheKey } from "../../lib/diffRendering";
import {
  projectListEntriesQueryOptions,
  projectReadFileQueryOptions,
} from "../../lib/projectReactQuery";
import { readLocalApi } from "../../localApi";
import { openInPreferredEditor } from "../../editorPreferences";
import { resolvePathLinkTarget } from "../../terminal-links";
import { resolveWorkspaceSelectionPath } from "../../filePathDisplay";
import {
  buildProposedPlanMarkdownFilename,
  normalizePlanMarkdownForExport,
} from "../../proposedPlan";
import { readEnvironmentApi } from "~/environmentApi";
import type { ActivePlanState, LatestProposedPlanState, WorkLogEntry } from "../../session-logic";
import type { TurnDiffSummary } from "../../types";
import {
  describeWorkspaceArtifact,
  selectRecentArtifactOutputs,
  type WorkspaceArtifact,
} from "../../workspaceArtifacts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

import { PaneCard } from "./PaneCard";
import { useConsolePaneCollapsed, useConsolePaneVisibility } from "./consolePaneState";
import { RecentChangesPane } from "./RecentChangesPane";
import { TaskPane } from "./TaskPane";
import { TreePane, TreePaneRevealAction } from "./TreePane";
import { ViewerPane, type ViewerDocumentMode } from "./ViewerPane";
import {
  CONSOLE_PANE_ORDER,
  type ConsolePaneDescriptor,
  type ConsolePaneId,
  type ConsolePaneVisibilityMap,
} from "./consoleTypes";

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

function textPreviewForFileDiff(fileDiff: FileDiffMetadata | undefined): string | null {
  if (!fileDiff) {
    return null;
  }
  const sourceLines = fileDiff.type === "deleted" ? fileDiff.deletionLines : fileDiff.additionLines;
  const normalizedLines = sourceLines
    .map((line) => line.replace(/\t/g, "  ").replace(/\s+$/g, ""))
    .join("\n")
    .trim();
  if (normalizedLines.length === 0) {
    return null;
  }
  return normalizedLines.split("\n").slice(0, 20).join("\n");
}

function ancestorPathsOf(path: string | null): string[] {
  if (!path) return [];
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const ancestors: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join("/"));
  }
  return ancestors;
}

function firstFilePath(entries: ReadonlyArray<ProjectEntry> | undefined): string | null {
  return entries?.find((entry) => entry.kind === "file")?.path ?? null;
}

function paneIconFor(id: ConsolePaneId) {
  switch (id) {
    case "tree":
      return FilesIcon;
    case "recent":
      return HistoryIcon;
    case "task":
      return ListChecksIcon;
  }
}

function paneLabelFor(id: ConsolePaneId) {
  switch (id) {
    case "tree":
      return "Files";
    case "recent":
      return "Recent edited files";
    case "task":
      return "Tasks";
  }
}

function paneDescriptionFor(id: ConsolePaneId) {
  switch (id) {
    case "tree":
      return "Browse the project's folder tree";
    case "recent":
      return "Files the agent recently created or edited";
    case "task":
      return "Active plan, status, and recent work";
  }
}

/**
 * Last segment of a path, with trailing slashes stripped. We use the
 * workspace root's basename as the Files card title so the user immediately
 * sees which folder they're in (e.g. "server" rather than the generic "Files").
 */
function basenameOfPath(path: string | undefined): string {
  if (!path) return "Files";
  const trimmed = path.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

interface ConsoleRailProps {
  open: boolean;
  mode?: "sheet" | "sidebar";
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  workspaceRoot: string | undefined;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  artifacts: ReadonlyArray<WorkspaceArtifact>;
  workEntries: ReadonlyArray<WorkLogEntry>;
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  inferredCheckpointTurnCountByTurnId: Readonly<Record<string, number>>;
  focusedPath?: string | null;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  onClose: () => void;
  onOpenTurnDiff?: (turnId: TurnId, filePath?: string) => void;
  onAddTextToChat?: (input: { path: string; text: string }) => void;
}

const ConsoleRail = memo(function ConsoleRail({
  open,
  mode = "sidebar",
  environmentId,
  threadId,
  workspaceRoot,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  artifacts,
  workEntries,
  activePlan,
  activeProposedPlan,
  turnDiffSummaries,
  inferredCheckpointTurnCountByTurnId,
  focusedPath,
  expanded = false,
  onToggleExpanded,
  onClose,
  onOpenTurnDiff,
  onAddTextToChat,
}: ConsoleRailProps) {
  // ----- pane visibility + collapse state -----
  const [paneVisibility, , togglePane] = useConsolePaneVisibility();
  const [paneCollapsed, togglePaneCollapsed] = useConsolePaneCollapsed();

  // ----- shared cross-pane state -----
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [documentViewMode, setDocumentViewMode] = useState<ViewerDocumentMode>("preview");
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set());
  const [isSavingPlanToWorkspace, setIsSavingPlanToWorkspace] = useState(false);
  const [selectedDocumentText, setSelectedDocumentText] = useState("");
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const planAutoOpenedRef = useRef<string | null>(null);

  // ----- viewer takeover state -----
  // The viewer is not a stack card — it's a takeover overlay. Open it by
  // selecting a file in the tree (or via a chat link); close it with the X
  // in the viewer header to return to the stack.
  const [viewerOverlayOpen, setViewerOverlayOpen] = useState(false);

  // Auto-open the task pane the first time a plan becomes available for a
  // thread. Once the user explicitly hides the pane, we don't pop it back
  // open for the same plan.
  useEffect(() => {
    const planKey = activePlan
      ? `active:${activePlan.turnId ?? "unknown"}:${activePlan.createdAt}`
      : activeProposedPlan
        ? `proposed:${activeProposedPlan.id}`
        : null;
    if (!planKey) {
      planAutoOpenedRef.current = null;
      return;
    }
    if (planAutoOpenedRef.current === planKey) {
      return;
    }
    planAutoOpenedRef.current = planKey;
    if (!paneVisibility.task) {
      togglePane("task");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlan, activeProposedPlan]);

  // ----- recent artifacts + changed-paths memo -----
  const recentArtifacts = useMemo(() => selectRecentArtifactOutputs(artifacts), [artifacts]);
  const changedPaths = useMemo(
    () => new Set(artifacts.map((artifact) => artifact.path)),
    [artifacts],
  );

  // ----- workspace entries query -----
  const workspaceEntriesQuery = useQuery(
    projectListEntriesQueryOptions({
      environmentId,
      cwd: workspaceRoot ?? null,
      enabled: open && !!workspaceRoot,
      limit: 8_000,
    }),
  );

  // Pick a sensible default selection when the panel opens or the project
  // changes. We only *clear* an existing selection if we have positive
  // evidence the path is gone — otherwise an externally-set focusedPath can
  // get clobbered before the entries query loads.
  useEffect(() => {
    if (selectedPath) {
      const haveEntriesData = !!workspaceEntriesQuery.data;
      const haveArtifacts = artifacts.length > 0;
      if (!haveEntriesData && !haveArtifacts) {
        return;
      }
      const stillExists =
        workspaceEntriesQuery.data?.entries.some((entry) => entry.path === selectedPath) ||
        artifacts.some((artifact) => artifact.path === selectedPath);
      if (stillExists) {
        return;
      }
    }
    setSelectedPath(
      recentArtifacts[0]?.path ??
        artifacts[0]?.path ??
        firstFilePath(workspaceEntriesQuery.data?.entries) ??
        null,
    );
  }, [artifacts, recentArtifacts, selectedPath, workspaceEntriesQuery.data]);

  // Honor an external "focus this file" request from chat links — open the
  // viewer takeover so the file is immediately readable.
  useEffect(() => {
    if (!focusedPath) {
      return;
    }
    setSelectedPath(focusedPath);
    setDocumentViewMode("preview");
    setViewerOverlayOpen(true);
  }, [focusedPath]);

  // Auto-expand all ancestors of the selection so the tree can scroll to it.
  useEffect(() => {
    if (!selectedPath) {
      return;
    }
    setExpandedDirectories((current) => {
      const next = new Set(current);
      for (const ancestor of ancestorPathsOf(selectedPath)) {
        next.add(ancestor);
      }
      if (next.size === current.size && [...next].every((path) => current.has(path))) {
        return current;
      }
      return next;
    });
  }, [selectedPath]);

  // Reset the "selected text" buffer when context changes.
  useEffect(() => {
    setSelectedDocumentText("");
  }, [documentViewMode, selectedPath]);

  // ----- file tree -----
  const workspaceTree = useMemo<ReadonlyArray<WorkspaceTreeNode>>(
    () =>
      buildWorkspaceFileTree({
        entries: workspaceEntriesQuery.data?.entries ?? [],
        changedPaths,
      }),
    [changedPaths, workspaceEntriesQuery.data?.entries],
  );

  // ----- selected file state -----
  const selectedArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.path === selectedPath) ?? null,
    [artifacts, selectedPath],
  );
  const selectedDescriptor = useMemo(
    () => (selectedPath ? describeWorkspaceArtifact(selectedPath) : null),
    [selectedPath],
  );

  // ----- diff support (drives the patch preview fallback in the viewer) -----
  const conversationCheckpointTurnCount = useMemo(() => {
    const turnCounts = turnDiffSummaries
      .map(
        (summary) =>
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
      )
      .filter((value): value is number => typeof value === "number");
    if (turnCounts.length === 0) {
      return null;
    }
    return Math.max(...turnCounts);
  }, [inferredCheckpointTurnCountByTurnId, turnDiffSummaries]);

  const checkpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      environmentId,
      threadId,
      fromTurnCount: 0,
      toTurnCount: conversationCheckpointTurnCount,
      cacheScope: "console-rail",
      enabled: open && artifacts.length > 0 && conversationCheckpointTurnCount !== null,
    }),
  );

  const fileDiffByPath = useMemo(() => {
    const patch = checkpointDiffQuery.data?.diff?.trim();
    if (!patch) {
      return new Map<string, FileDiffMetadata>();
    }
    try {
      const parsed = parsePatchFiles(patch, buildPatchCacheKey(patch, "console-rail"));
      const next = new Map<string, FileDiffMetadata>();
      for (const parsedPatch of parsed) {
        for (const file of parsedPatch.files) {
          next.set(resolveFileDiffPath(file), file);
        }
      }
      return next;
    } catch {
      return new Map<string, FileDiffMetadata>();
    }
  }, [checkpointDiffQuery.data?.diff]);

  const selectedFileDiff = selectedPath ? fileDiffByPath.get(selectedPath) : undefined;
  const selectedPatchPreview = useMemo(
    () => textPreviewForFileDiff(selectedFileDiff),
    [selectedFileDiff],
  );

  // ----- text preview query (for viewer pane) -----
  const textFileQuery = useQuery(
    projectReadFileQueryOptions({
      environmentId,
      cwd: workspaceRoot ?? null,
      relativePath: selectedPath ? resolveWorkspaceSelectionPath(selectedPath, workspaceRoot) : null,
      enabled: viewerOverlayOpen && !!workspaceRoot && selectedDescriptor?.previewKind === "text",
      maxBytes: 24_000,
    }),
  );

  // ----- helpers shared between panes -----
  const resolveArtifactTargetPath = useCallback(
    (path: string) => (workspaceRoot ? resolvePathLinkTarget(path, workspaceRoot) : path),
    [workspaceRoot],
  );

  const openArtifactInEditor = useCallback(
    (path: string) => {
      const api = readLocalApi();
      if (!api) return;
      const targetPath = resolveArtifactTargetPath(path);
      void openInPreferredEditor(api, targetPath).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not open file",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      });
    },
    [resolveArtifactTargetPath],
  );

  const openArtifactInNativeApp = useCallback(
    (path: string) => {
      const api = readLocalApi();
      if (!api) return;
      const targetPath = resolveArtifactTargetPath(path);
      void api.shell.openInEditor(targetPath, "file-manager").catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not open file",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      });
    },
    [resolveArtifactTargetPath],
  );

  const revealWorkspaceRoot = useCallback(() => {
    const api = readLocalApi();
    if (!api || !workspaceRoot) return;
    void api.shell.openInEditor(workspaceRoot, "file-manager").catch((error) => {
      toastManager.add({
        type: "error",
        title: "Could not open folder",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, [workspaceRoot]);

  const savePlanToWorkspace = useCallback(() => {
    const planMarkdown = activeProposedPlan?.planMarkdown ?? null;
    if (!workspaceRoot || !planMarkdown) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }
    setIsSavingPlanToWorkspace(true);
    const filename = buildProposedPlanMarkdownFilename(planMarkdown);
    void api.projects
      .writeFile({
        cwd: workspaceRoot,
        relativePath: filename,
        contents: normalizePlanMarkdownForExport(planMarkdown),
      })
      .then((result) => {
        toastManager.add({
          type: "success",
          title: "Plan saved",
          description: result.relativePath,
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not save plan",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      })
      .finally(() => {
        setIsSavingPlanToWorkspace(false);
      });
  }, [activeProposedPlan?.planMarkdown, environmentId, workspaceRoot]);

  const saveWorkspaceFile = useCallback(
    async ({ path, contents }: { path: string; contents: string }) => {
      if (!workspaceRoot) {
        toastManager.add({
          type: "error",
          title: "Could not save file",
          description: "No workspace folder is selected.",
        });
        throw new Error("workspace root unavailable");
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Could not save file",
          description: "Workspace connection isn't ready.",
        });
        throw new Error("environment api unavailable");
      }
      // The viewer hands us the full path; projects.writeFile expects a
      // relative path under cwd, so normalize absolute + workspace-labelled
      // paths before writing.
      const relativePath = resolveWorkspaceSelectionPath(path, workspaceRoot);
      if (relativePath === null) {
        toastManager.add({
          type: "error",
          title: "Could not save file",
          description: "The selected file is outside the active workspace.",
        });
        throw new Error("file path outside workspace");
      }
      try {
        const result = await api.projects.writeFile({
          cwd: workspaceRoot,
          relativePath,
          contents,
        });
        toastManager.add({
          type: "success",
          title: "File saved",
          description: result.relativePath,
        });
        // Refetch the on-disk text so subsequent reads reflect the new bytes.
        void textFileQuery.refetch();
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not save file",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        throw error;
      }
    },
    [environmentId, textFileQuery, workspaceRoot],
  );

  const syncSelectedDocumentText = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setSelectedDocumentText("");
      return;
    }
    const nextText = selection.toString().trim();
    setSelectedDocumentText(nextText.slice(0, 12_000));
  }, []);

  const addSelectedTextToChat = useCallback(() => {
    if (!selectedPath || !selectedDocumentText.trim() || !onAddTextToChat) {
      return;
    }
    onAddTextToChat({
      path: selectedPath,
      text: selectedDocumentText.trim(),
    });
    setSelectedDocumentText("");
  }, [onAddTextToChat, selectedDocumentText, selectedPath]);

  const refreshWorkspace = useCallback(() => {
    void workspaceEntriesQuery.refetch();
    void checkpointDiffQuery.refetch();
    if (selectedDescriptor?.previewKind === "text") {
      void textFileQuery.refetch();
    }
  }, [checkpointDiffQuery, selectedDescriptor?.previewKind, textFileQuery, workspaceEntriesQuery]);

  // Selecting a file from anywhere in the rail opens the viewer takeover.
  const selectWorkspaceFile = useCallback((path: string) => {
    setSelectedPath(path);
    setDocumentViewMode("preview");
    setViewerOverlayOpen(true);
  }, []);

  const openWorkspaceFileFromLink = useCallback(
    (path: string) => {
      const selectionPath = resolveWorkspaceSelectionPath(path, workspaceRoot);
      if (selectionPath === null) {
        return false;
      }
      selectWorkspaceFile(selectionPath);
      return true;
    },
    [selectWorkspaceFile, workspaceRoot],
  );

  const handleToggleDirectory = useCallback((path: string) => {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const closeViewerOverlay = useCallback(() => {
    setViewerOverlayOpen(false);
    // Expand is a viewer-scoped affordance — when the user closes the viewer
    // we collapse the rail back so the chat column reappears in one move.
    if (expanded && onToggleExpanded) {
      onToggleExpanded();
    }
  }, [expanded, onToggleExpanded]);

  // ----- diff entry-points for tree pane -----
  const firstDiffCapableArtifact = useMemo(
    () => artifacts.find((artifact) => !!artifact.turnId) ?? null,
    [artifacts],
  );

  // ----- pane registry -----
  const panes = useMemo<ReadonlyArray<ConsolePaneDescriptor>>(
    () =>
      CONSOLE_PANE_ORDER.map((id) => ({
        id,
        label: paneLabelFor(id),
        description: paneDescriptionFor(id),
        Icon: paneIconFor(id),
      })),
    [],
  );

  const visibleIds = useMemo<ReadonlyArray<ConsolePaneId>>(
    () => panes.filter((p) => paneVisibility[p.id]).map((p) => p.id),
    [paneVisibility, panes],
  );

  // Header summary
  const headerSummary = workspaceEntriesQuery.data?.entries.length
    ? `${workspaceEntriesQuery.data.entries.length} files and folders`
    : artifacts.length > 0
      ? `${artifacts.length} changed files`
      : "Browse the project and review outputs";

  const showViewerOverlay = viewerOverlayOpen && !!selectedPath;

  return (
    <div
      data-panel-mode={mode}
      className="relative flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-card/55 [-webkit-app-region:no-drag]"
    >
      <RailHeader
        summary={headerSummary}
        panes={panes}
        visibility={paneVisibility}
        onTogglePane={togglePane}
        onClose={onClose}
      />

      {/* Stack body — vertical scroll of cards. Always rendered so its state
          (scroll position, query data, etc.) survives viewer takeover. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
          {visibleIds.length === 0 ? (
            <EmptyRailState onShowFiles={() => togglePane("tree")} />
          ) : (
            visibleIds.map((id) => {
              const descriptor = panes.find((p) => p.id === id)!;
              const cardTitle = id === "tree" ? basenameOfPath(workspaceRoot) : descriptor.label;
              return (
                <PaneCard
                  key={id}
                  id={id}
                  title={cardTitle}
                  Icon={descriptor.Icon}
                  collapsed={paneCollapsed[id]}
                  onToggleCollapsed={() => togglePaneCollapsed(id)}
                  onClose={() => togglePane(id)}
                  headerActions={
                    id === "tree" ? (
                      <TreePaneRevealAction
                        workspaceRoot={workspaceRoot}
                        onRevealWorkspaceRoot={revealWorkspaceRoot}
                      />
                    ) : null
                  }
                >
                  {id === "tree" ? (
                    <TreePane
                      resolvedTheme={resolvedTheme}
                      treeNodes={workspaceTree}
                      treeIsLoading={workspaceEntriesQuery.isLoading}
                      selectedPath={selectedPath}
                      expandedDirectories={expandedDirectories}
                      selectedArtifact={selectedArtifact}
                      firstDiffCapableArtifact={firstDiffCapableArtifact}
                      onSelectFile={selectWorkspaceFile}
                      onToggleDirectory={handleToggleDirectory}
                      onOpenTurnDiff={onOpenTurnDiff}
                    />
                  ) : id === "recent" ? (
                    <RecentChangesPane
                      workspaceRoot={workspaceRoot}
                      resolvedTheme={resolvedTheme}
                      recentArtifacts={recentArtifacts}
                      onSelectFile={selectWorkspaceFile}
                    />
                  ) : (
                    <TaskPane
                      workspaceRoot={workspaceRoot}
                      markdownCwd={markdownCwd}
                      timestampFormat={timestampFormat}
                      activePlan={activePlan}
                      activeProposedPlan={activeProposedPlan}
                      workEntries={workEntries}
                      isSavingPlanToWorkspace={isSavingPlanToWorkspace}
                      isPlanCopied={isCopied}
                      onCopyPlan={(markdown) => copyToClipboard(markdown)}
                      onSavePlanToWorkspace={savePlanToWorkspace}
                      onOpenWorkspaceFileLink={openWorkspaceFileFromLink}
                    />
                  )}
                </PaneCard>
              );
            })
          )}
        </div>
      </ScrollArea>

      {/* Viewer takeover — full-bleed overlay covering the entire rail
          (including the header, so the rail's panel-collapse button isn't
          stacked on top of the viewer's own X). */}
      {showViewerOverlay ? (
        <div data-viewer-overlay className="absolute inset-0 z-20 flex flex-col bg-card">
          <ViewerPane
            workspaceRoot={workspaceRoot}
            markdownCwd={markdownCwd}
            resolvedTheme={resolvedTheme}
            timestampFormat={timestampFormat}
            selectedPath={selectedPath}
            selectedArtifact={selectedArtifact}
            documentViewMode={documentViewMode}
            documentText={textFileQuery.data?.contents ?? null}
            documentTextTruncated={textFileQuery.data?.truncated ?? false}
            documentTextLoading={textFileQuery.isLoading}
            patchPreview={textFileQuery.isError ? selectedPatchPreview : null}
            selectedDocumentTextSelection={selectedDocumentText}
            onSetDocumentViewMode={setDocumentViewMode}
            onRefresh={refreshWorkspace}
            onOpenInApp={openArtifactInNativeApp}
            onOpenInEditor={openArtifactInEditor}
            onSyncSelection={syncSelectedDocumentText}
            onClearSelection={() => setSelectedDocumentText("")}
            onAddSelectionToChat={addSelectedTextToChat}
            onOpenWorkspaceFileLink={openWorkspaceFileFromLink}
            onOpenTurnDiff={onOpenTurnDiff}
            expanded={expanded}
            onToggleExpanded={mode === "sidebar" ? onToggleExpanded : undefined}
            onSaveFile={saveWorkspaceFile}
            onClosePane={closeViewerOverlay}
          />
        </div>
      ) : null}
    </div>
  );
});

// ----- header -----

interface RailHeaderProps {
  summary: string;
  panes: ReadonlyArray<ConsolePaneDescriptor>;
  visibility: ConsolePaneVisibilityMap;
  onTogglePane: (id: ConsolePaneId) => void;
  onClose: () => void;
}

function RailHeader({ summary, panes, visibility, onTogglePane, onClose }: RailHeaderProps) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3 [-webkit-app-region:no-drag]">
      <div className="flex min-w-0 items-center gap-2">
        {/* Console pane picker — chip-styled trigger so it reads as
            interactive at a glance. Click opens a checkbox menu of available
            stack cards. */}
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label="Add or remove console panes"
                title="Add or remove console panes"
                className="flex h-7 items-center gap-1.5 rounded-full border border-blue-200/80 bg-blue-500/10 px-2.5 text-[11px] font-semibold tracking-wide text-blue-600 uppercase transition-colors hover:bg-blue-500/15 dark:border-blue-400/30 dark:text-blue-300"
              />
            }
          >
            <Badge
              variant="secondary"
              className="bg-transparent p-0 text-[11px] font-semibold tracking-wide text-blue-600 uppercase shadow-none dark:text-blue-300"
            >
              Console
            </Badge>
            <PlusIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="start" className="min-w-[14rem]">
            <div className="px-2 py-1 text-[10px] font-semibold tracking-[0.16em] text-muted-foreground/55 uppercase">
              Show in stack
            </div>
            {panes.map((pane) => {
              const active = visibility[pane.id];
              const Icon = pane.Icon;
              return (
                <MenuCheckboxItem
                  key={pane.id}
                  checked={active}
                  onCheckedChange={() => onTogglePane(pane.id)}
                  className="min-h-8"
                >
                  <Icon className="size-3.5 text-muted-foreground/75" />
                  <span>{pane.label}</span>
                </MenuCheckboxItem>
              );
            })}
          </MenuPopup>
        </Menu>
        <span className="truncate text-[11px] text-muted-foreground/68">{summary}</span>
      </div>

      <div className="flex items-center gap-1">
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={onClose}
          aria-label="Collapse console panel"
          title="Collapse console panel"
          className="text-muted-foreground/55 hover:text-foreground/80"
        >
          <PanelRightCloseIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ----- empty state when nothing is visible -----

function EmptyRailState({ onShowFiles }: { onShowFiles: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-sm rounded-2xl border border-dashed border-border/60 bg-background/50 p-5 text-center">
        <p className="text-sm font-medium text-foreground/88">No panes are showing</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground/70">
          Open the Console menu in the header to add Files, Tasks, Recent edited files, and other
          cards to your stack.
        </p>
        <Button size="xs" variant="outline" className="mt-3" onClick={onShowFiles}>
          Show Files
        </Button>
      </div>
    </div>
  );
}

export default ConsoleRail;
