import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { EnvironmentId, ScopedProjectRef } from "@forma/contracts";
import * as Schema from "effect/Schema";
import {
  IconChevronLeft as ChevronLeftIcon,
  IconSidebarTrailing as PanelRightCloseIcon,
} from "symbols-react";
import { useCallback } from "react";

import { useComposerHandleContext } from "../composerHandleContext";
import {
  buildDiffClosedSearch,
  buildDiffEditorSearch,
  buildDiffFilesSearch,
  parseDiffRouteSearch,
} from "../diffRouteSearch";
import { openInPreferredEditor } from "../editorPreferences";
import { useTheme } from "../hooks/useTheme";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { type CodeContextSelection } from "../lib/codeContext";
import { invalidateProjectQueries } from "../lib/projectReactQuery";
import { cn } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { resolvePathLinkTarget } from "../terminal-links";
import {
  type ThreadRouteTarget,
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
} from "../threadRoutes";
import { classifyPreviewRelativePath, openPreviewTarget } from "../previewTargets";
import { DiffFileEditorPane } from "./DiffFileEditorPane";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { WorkspaceFilesTree } from "./WorkspaceFilesTree";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { toastManager } from "./ui/toast";

const WORKSPACE_PANEL_TREE_COLLAPSED_KEY = "forma:workspace-panel-tree-collapsed:v1";
const WorkspacePanelTreeCollapsedSchema = Schema.Record(Schema.String, Schema.Boolean);

interface WorkspaceFilesPanelProps {
  mode?: DiffPanelMode;
  routeTarget: ThreadRouteTarget;
  environmentId: EnvironmentId;
  panelKey: string;
  workspaceRoot: string | null;
  activeProjectRef: ScopedProjectRef | null;
}

export function WorkspaceFilesPanel({
  mode = "inline",
  routeTarget,
  environmentId,
  panelKey,
  workspaceRoot,
  activeProjectRef,
}: WorkspaceFilesPanelProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const composerRef = useComposerHandleContext();
  const { resolvedTheme } = useTheme();
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const editorFilePath = diffSearch.editorFilePath ?? null;
  const editorLine = diffSearch.editorLine;
  const editorColumn = diffSearch.editorColumn;
  const [treeCollapsedByWorkspace, setTreeCollapsedByWorkspace] = useLocalStorage(
    WORKSPACE_PANEL_TREE_COLLAPSED_KEY,
    {},
    WorkspacePanelTreeCollapsedSchema,
  );
  const treeCollapsed = workspaceRoot ? (treeCollapsedByWorkspace[workspaceRoot] ?? false) : false;

  const navigateToCurrentRoute = useCallback(
    (updateSearch: (previous: Record<string, unknown>) => Record<string, unknown>) => {
      if (routeTarget.kind === "server") {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(routeTarget.threadRef),
          search: updateSearch,
        });
        return;
      }

      void navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(routeTarget.draftId),
        search: updateSearch,
      });
    },
    [navigate, routeTarget],
  );

  const toggleTreeCollapsed = useCallback(() => {
    if (!workspaceRoot) {
      return;
    }
    setTreeCollapsedByWorkspace((current) => ({
      ...current,
      [workspaceRoot]: !(current[workspaceRoot] ?? false),
    }));
  }, [setTreeCollapsedByWorkspace, workspaceRoot]);

  const addEditorCodeContext = useCallback(
    (selection: CodeContextSelection) => {
      const composerHandle = composerRef?.current;
      if (!composerHandle) {
        toastManager.add({
          type: "error",
          title: "Composer is unavailable",
        });
        return;
      }

      const added = composerHandle.addCodeContext(selection, {
        focusComposerAfterInsert: false,
      });
      toastManager.add({
        type: added ? "success" : "info",
        title: added ? "Code added to composer" : "Code already attached",
      });
    },
    [composerRef],
  );

  const openWorkspaceFileInEditor = useCallback(
    (filePath: string) => {
      const api = readLocalApi();
      if (!api || !workspaceRoot) return;
      void openInPreferredEditor(api, resolvePathLinkTarget(filePath, workspaceRoot)).catch(
        (error) => {
          console.warn("Failed to open workspace file in editor.", error);
        },
      );
    },
    [workspaceRoot],
  );

  const previewDisabledReasonForFile = useCallback(
    (filePath: string) => {
      if (!activeProjectRef) {
        return "Preview is unavailable until this workspace is attached to a project.";
      }
      const classification = classifyPreviewRelativePath(filePath);
      return classification.enabled ? null : (classification.reason ?? "Preview is unavailable.");
    },
    [activeProjectRef],
  );

  const openPreviewForFile = useCallback(
    (filePath: string) => {
      if (!activeProjectRef) {
        return;
      }
      const classification = classifyPreviewRelativePath(filePath);
      if (!classification.enabled || !classification.targetKind) {
        return;
      }
      openPreviewTarget(activeProjectRef, {
        targetKind: classification.targetKind,
        relativePath: filePath,
      });
    },
    [activeProjectRef],
  );

  const persistSavedWorkspaceFile = useCallback(async () => {
    if (!workspaceRoot) {
      return;
    }
    await invalidateProjectQueries(queryClient, {
      environmentId,
      cwd: workspaceRoot,
    });
  }, [environmentId, queryClient, workspaceRoot]);

  const selectFile = useCallback(
    (filePath: string) => {
      navigateToCurrentRoute((previous) =>
        buildDiffEditorSearch(previous, {
          filePath,
          backToView: "files",
        }),
      );
    },
    [navigateToCurrentRoute],
  );

  const editorSessionKey = editorFilePath
    ? `workspace-files:${panelKey}:${editorFilePath}`
    : undefined;

  return (
    <DiffPanelShell mode={mode}>
      {!workspaceRoot ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Files are unavailable until this thread has an active project.
        </div>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1">
          <div
            className={cn(
              "flex min-h-0 shrink-0 flex-col border-r border-border/70 bg-card/50 transition-[width] duration-150",
              treeCollapsed ? "w-11" : "w-72",
            )}
          >
            <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/70 px-2">
              {treeCollapsed ? null : (
                <span className="text-ui-xs font-semibold tracking-[0.14em] text-muted-foreground/70 uppercase">
                  Files
                </span>
              )}
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={toggleTreeCollapsed}
                aria-label={treeCollapsed ? "Expand files tree" : "Collapse files tree"}
                title={treeCollapsed ? "Expand files tree" : "Collapse files tree"}
              >
                {treeCollapsed ? (
                  <ChevronLeftIcon className="size-3.5" />
                ) : (
                  <PanelRightCloseIcon className="size-3.5" />
                )}
              </Button>
            </div>
            {treeCollapsed ? null : (
              <ScrollArea className="min-h-0 flex-1 px-1.5 py-2">
                <WorkspaceFilesTree
                  cwd={workspaceRoot}
                  environmentId={environmentId}
                  sessionKey={`${panelKey}:${workspaceRoot}`}
                  resolvedTheme={resolvedTheme}
                  selectedFilePath={editorFilePath}
                  onSelectFile={selectFile}
                />
              </ScrollArea>
            )}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {editorFilePath ? (
              <DiffFileEditorPane
                key={editorSessionKey ?? editorFilePath}
                cwd={workspaceRoot}
                environmentId={environmentId}
                sessionKey={editorSessionKey}
                fileDiff={null}
                filePath={editorFilePath}
                filePaths={[editorFilePath]}
                initialColumn={editorColumn}
                initialLine={editorLine}
                initialOverride={undefined}
                navigationLabel={
                  diffSearch.editorBackToView === "files" ? "Back to files" : "Close editor"
                }
                resolvedTheme={resolvedTheme}
                onAddCodeContext={addEditorCodeContext}
                onOpenInEditor={openWorkspaceFileInEditor}
                onOpenPreview={openPreviewForFile}
                previewDisabledReason={previewDisabledReasonForFile(editorFilePath)}
                onPersisted={persistSavedWorkspaceFile}
                onRequestBack={() => {
                  if (diffSearch.editorBackToView === "files") {
                    navigateToCurrentRoute((previous) => buildDiffFilesSearch(previous));
                    return;
                  }
                  navigateToCurrentRoute((previous) => buildDiffClosedSearch(previous));
                }}
                onRequestFilePathChange={(filePath) => {
                  navigateToCurrentRoute((previous) =>
                    buildDiffEditorSearch(previous, {
                      filePath,
                      backToView: diffSearch.editorBackToView ?? "files",
                    }),
                  );
                }}
              />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div className="max-w-sm space-y-2">
                  <p className="text-sm font-medium text-foreground">Select a file to open it.</p>
                  <p className="text-sm text-muted-foreground">
                    Browse the workspace tree to inspect and edit project files without leaving
                    chat.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </DiffPanelShell>
  );
}
