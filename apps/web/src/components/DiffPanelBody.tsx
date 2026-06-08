import { CodeView, type CodeViewDiffItem, type CodeViewHandle } from "@pierre/diffs/react";
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import type { TurnId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { adaptFileDiffsToTreeChanges } from "../lib/diffFileTreeAdapter";
import {
  buildFileDiffRenderKey,
  DIFF_RENDER_UNSAFE_CSS,
  resolveDiffThemeName,
  resolveFileDiffPath,
  type RenderablePatch,
} from "../lib/diffRendering";
import { ChangedFilesTree } from "./chat/ChangedFilesTree";

type DiffThemeType = "light" | "dark";

export interface DiffPanelBodyProps {
  renderablePatch: RenderablePatch;
  selectedFilePath: string | null;
  diffRenderMode: "stacked" | "split";
  diffWordWrap: boolean;
  collapsedFileKeys: ReadonlySet<string>;
  onToggleFileCollapse: (fileKey: string) => void;
  resolvedTheme: DiffThemeType;
  railCollapsed: boolean;
  railSize: number;
  onRailResize: (size: number) => void;
  railMinSize: number;
  railMaxSize: number;
  onSelectFile: (filePath: string) => void;
  onOpenFileInEditor: (filePath: string) => void;
}

export function DiffPanelBody(props: DiffPanelBodyProps) {
  const {
    renderablePatch,
    selectedFilePath,
    diffRenderMode,
    diffWordWrap,
    collapsedFileKeys,
    onToggleFileCollapse,
    resolvedTheme,
    railCollapsed,
    railSize,
    onRailResize,
    railMinSize,
    railMaxSize,
    onSelectFile,
    onOpenFileInEditor,
  } = props;

  const codeViewRef = useRef<CodeViewHandle<undefined>>(null);

  const files = renderablePatch.kind === "files" ? renderablePatch.files : [];

  const treeFiles = useMemo(() => adaptFileDiffsToTreeChanges(files), [files]);

  const codeViewItems = useMemo<readonly CodeViewDiffItem<undefined>[]>(
    () =>
      files.map((fileDiff) => {
        const fileKey = buildFileDiffRenderKey(fileDiff);
        const collapsed = collapsedFileKeys.has(fileKey);
        return {
          id: resolveFileDiffPath(fileDiff),
          type: "diff",
          fileDiff,
          collapsed,
          // CodeView only re-applies a controlled item when its `version`
          // changes (see syncItemRecord), so bump it when collapse toggles.
          version: collapsed ? 1 : 0,
        };
      }),
    [collapsedFileKeys, files],
  );

  const codeViewOptions = useMemo(
    () => ({
      diffStyle: diffRenderMode === "split" ? ("split" as const) : ("unified" as const),
      lineDiffType: "none" as const,
      overflow: diffWordWrap ? ("wrap" as const) : ("scroll" as const),
      theme: resolveDiffThemeName(resolvedTheme),
      themeType: resolvedTheme,
      unsafeCSS: DIFF_RENDER_UNSAFE_CSS,
      stickyHeaders: true,
    }),
    [diffRenderMode, diffWordWrap, resolvedTheme],
  );

  const scrollToFile = useCallback((filePath: string) => {
    const handle = codeViewRef.current;
    if (!handle) return;
    handle.scrollTo({ type: "item", id: filePath, align: "start" });
  }, []);

  const handleSelectFile = useCallback(
    (filePath: string) => {
      // Scroll imperatively so re-selecting the same file still navigates, and
      // so the scroll is driven by the click rather than a state round-trip.
      scrollToFile(filePath);
      onSelectFile(filePath);
    },
    [onSelectFile, scrollToFile],
  );

  // Deep-link / external selection (e.g. from chat): scroll once items exist.
  useEffect(() => {
    if (!selectedFilePath) return;
    const frame = window.requestAnimationFrame(() => scrollToFile(selectedFilePath));
    return () => window.cancelAnimationFrame(frame);
  }, [selectedFilePath, codeViewItems, scrollToFile]);

  if (renderablePatch.kind === "raw") {
    return (
      <div className="h-full overflow-auto p-2">
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
          <pre
            className={cn(
              "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
              diffWordWrap ? "overflow-auto whitespace-pre-wrap wrap-break-word" : "overflow-auto",
            )}
          >
            {renderablePatch.text}
          </pre>
        </div>
      </div>
    );
  }

  const treeRail = (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-1 py-2">
        {treeFiles.length === 0 ? (
          <p className="px-2 py-1 text-[11px] text-muted-foreground/60">No files changed.</p>
        ) : (
          <ChangedFilesTree
            turnId={"" as TurnId}
            files={treeFiles}
            allDirectoriesExpanded
            resolvedTheme={resolvedTheme}
            selectedFilePath={selectedFilePath}
            showStats={false}
            onOpenTurnDiff={(_turnId, filePath) => {
              if (filePath) handleSelectFile(filePath);
            }}
          />
        )}
      </div>
    </div>
  );

  const codeView =
    files.length === 0 ? (
      <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground/70">
        No files changed.
      </div>
    ) : (
      <CodeView
        ref={codeViewRef}
        className="diff-render-surface h-full min-h-0 min-w-0 overflow-auto px-2 pb-2"
        items={codeViewItems}
        options={codeViewOptions}
        renderHeaderPrefix={(item) => {
          if (item.type !== "diff") return null;
          const filePath = resolveFileDiffPath(item.fileDiff);
          const fileKey = buildFileDiffRenderKey(item.fileDiff);
          const collapsed = item.collapsed ?? false;
          return (
            <button
              type="button"
              aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
              aria-expanded={!collapsed}
              className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm border-0 bg-transparent p-0 align-middle text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-hidden"
              onClick={(event) => {
                event.stopPropagation();
                onToggleFileCollapse(fileKey);
              }}
            >
              {collapsed ? (
                <ChevronRightIcon className="size-3.5" />
              ) : (
                <ChevronDownIcon className="size-3.5" />
              )}
            </button>
          );
        }}
        renderHeaderMetadata={(item) => {
          const filePath = item.type === "diff" ? resolveFileDiffPath(item.fileDiff) : item.id;
          return (
            <button
              type="button"
              aria-label={`Open ${filePath}`}
              title="Open file in editor"
              className="flex size-4 shrink-0 items-center justify-center rounded-sm border-0 bg-transparent p-0 text-muted-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-hidden"
              onClick={(event) => {
                event.stopPropagation();
                onOpenFileInEditor(filePath);
              }}
            >
              <ExternalLinkIcon className="size-3.5" />
            </button>
          );
        }}
      />
    );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      <PanelGroup orientation="horizontal" className="flex min-h-0 min-w-0 flex-1">
        {!railCollapsed ? (
          <>
            <Panel
              id="diff-rail"
              defaultSize={`${railSize}%`}
              minSize={`${railMinSize}%`}
              maxSize={`${railMaxSize}%`}
              onResize={(panelSize) => onRailResize(panelSize.asPercentage)}
              className="min-h-0 min-w-0"
            >
              <div className="h-full min-w-0 border-r border-border/60">{treeRail}</div>
            </Panel>
            <PanelResizeHandle className="group relative w-px shrink-0 bg-border/60 data-[resize-handle-state=drag]:bg-primary data-[resize-handle-state=hover]:bg-primary/60">
              <div className="absolute inset-y-0 -left-1 right-[-3px] cursor-col-resize" />
            </PanelResizeHandle>
          </>
        ) : null}
        <Panel id="diff-main" minSize="20%" className="min-h-0 min-w-0">
          {codeView}
        </Panel>
      </PanelGroup>
    </div>
  );
}
