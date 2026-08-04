import type { VcsPanelFileChange, VcsPanelSnapshotResult } from "@t3tools/contracts";
import { FileDiff, useWorkerPool } from "@pierre/diffs/react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ComponentProps, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { getRenderablePatch, resolveDiffThemeName } from "~/lib/diffRendering";

import { Badge } from "../ui/badge";
import type { PanelChangedFile } from "./SourceControlPanel.logic";
import {
  COLLAPSED_SECTION_HEIGHT,
  COMMIT_PAGE_SIZE,
  WORKING_FILE_PREFETCH_MARGIN,
  sumFiles,
  type SectionKey,
} from "./SourceControlPanelModel";
import { BranchSyncLabels, FileChangeTooltipRow, StatLabels } from "./SourceControlPanelPrimitives";

export function CollapsibleSection({
  sectionKey,
  title,
  collapsed,
  weight,
  onToggle,
  onResizeStart,
  children,
  action,
}: {
  readonly sectionKey: SectionKey;
  readonly title: string;
  readonly collapsed: boolean;
  readonly weight: number;
  readonly onToggle: () => void;
  readonly onResizeStart: (key: SectionKey, event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <section
      data-source-control-section={sectionKey}
      className="flex min-h-0 flex-col overflow-hidden border-b border-border/70"
      style={
        collapsed
          ? { flex: `0 0 ${COLLAPSED_SECTION_HEIGHT}px` }
          : { flex: `${weight} 1 0`, minHeight: 0 }
      }
    >
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 px-2">
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 text-left text-xs font-semibold uppercase tracking-normal text-muted-foreground hover:text-foreground"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          <span className="truncate">{title}</span>
        </button>
        {action}
      </div>
      {!collapsed ? (
        <div data-source-control-section-content className="min-h-0 flex-1 overflow-auto px-2 pb-2">
          {children}
        </div>
      ) : null}
      {!collapsed ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize ${title}`}
          className="h-1 shrink-0 cursor-row-resize hover:bg-border"
          onMouseDown={(event) => onResizeStart(sectionKey, event)}
        />
      ) : null}
    </section>
  );
}

export function BranchBadge({ snapshot }: { readonly snapshot: VcsPanelSnapshotResult }) {
  const status = snapshot.status;
  if (!status.hasUpstream) {
    return (
      <Badge variant="warning" size="sm">
        No upstream
      </Badge>
    );
  }
  if (status.aheadCount === 0 && status.behindCount === 0) {
    return (
      <Badge variant="success" size="sm">
        Synced
      </Badge>
    );
  }
  return <BranchSyncLabels aheadCount={status.aheadCount} behindCount={status.behindCount} />;
}

export function FileChangeSummary({ files }: { readonly files: readonly VcsPanelFileChange[] }) {
  const stats = sumFiles(files);
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
      <span>{files.length === 1 ? "1 file" : `${files.length} files`}</span>
      <StatLabels insertions={stats.insertions} deletions={stats.deletions} />
    </span>
  );
}

export function FileChangeList({
  files,
  emptyLabel,
  onFileContextMenu,
  getFileKey,
  isFileExpanded,
  onFileToggle,
  renderExpandedFile,
  onOpenFile,
  onOpenInVsCode,
}: {
  readonly files: readonly VcsPanelFileChange[];
  readonly emptyLabel: string;
  readonly onFileContextMenu?: (
    event: ReactMouseEvent<HTMLDivElement>,
    file: VcsPanelFileChange,
  ) => void;
  readonly getFileKey?: (file: VcsPanelFileChange) => string;
  readonly isFileExpanded?: (file: VcsPanelFileChange) => boolean;
  readonly onFileToggle?: (file: VcsPanelFileChange) => void;
  readonly renderExpandedFile?: (file: VcsPanelFileChange) => ReactNode;
  readonly onOpenFile?: (file: VcsPanelFileChange) => void;
  readonly onOpenInVsCode?: (file: VcsPanelFileChange) => void;
}) {
  if (files.length === 0) {
    return <div className="px-3 py-1 text-xs text-muted-foreground">{emptyLabel}</div>;
  }
  return (
    <div className="space-y-0.5">
      {files.map((file) => {
        const fileKey = getFileKey?.(file) ?? `${file.path}:${file.status}`;
        const expanded = isFileExpanded?.(file) ?? false;
        return (
          <div key={fileKey} className="space-y-0.5">
            <FileChangeTooltipRow
              expanded={expanded}
              file={file}
              onFileContextMenu={onFileContextMenu}
              onFileToggle={onFileToggle}
              onOpenFile={onOpenFile}
              onOpenInVsCode={onOpenInVsCode}
            />
            {expanded && renderExpandedFile ? (
              <div className="ml-4 border-l border-border/60 pl-1">{renderExpandedFile(file)}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function LoadMoreCommitsButton({
  remaining,
  loading,
  onClick,
}: {
  readonly remaining: number;
  readonly loading: boolean;
  readonly onClick: () => void;
}) {
  if (remaining <= 0) return null;
  return (
    <button
      type="button"
      className="flex h-7 w-full items-center rounded px-1.5 text-left text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      disabled={loading}
      onClick={onClick}
    >
      Load {Math.min(COMMIT_PAGE_SIZE, remaining)} more of {remaining} remaining
    </button>
  );
}

export function WorkingFileRow({
  file,
  onRendered,
  renderFile,
}: {
  readonly file: PanelChangedFile;
  readonly onRendered: (file: PanelChangedFile) => void;
  readonly renderFile: (file: PanelChangedFile) => ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = rowRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      onRendered(file);
      return;
    }
    let didRender = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (didRender || !entries.some((entry) => entry.isIntersecting)) return;
        didRender = true;
        onRendered(file);
        observer.disconnect();
      },
      { rootMargin: `${WORKING_FILE_PREFETCH_MARGIN}px 0px` },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [file, onRendered]);
  return <div ref={rowRef}>{renderFile(file)}</div>;
}

export function InlineFileDiff({
  patch,
  resolvedTheme,
}: {
  readonly patch: string;
  readonly resolvedTheme: "light" | "dark";
}) {
  const renderablePatch = useMemo(
    () => getRenderablePatch(patch, `vcs-panel-file:${resolvedTheme}`),
    [patch, resolvedTheme],
  );
  if (!renderablePatch) {
    return <div className="px-2 py-1 text-xs text-muted-foreground">No diff.</div>;
  }
  if (renderablePatch.kind === "raw") {
    return (
      <pre className="max-h-80 overflow-auto rounded bg-muted/40 p-2 text-xs">
        {renderablePatch.text}
      </pre>
    );
  }
  return (
    <div className="max-h-96 overflow-auto rounded border border-border/60 bg-background/60">
      {renderablePatch.files.map((fileDiff) => (
        <WorkerRefreshedFileDiff
          key={fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name ?? "none"}`}
          fileDiff={fileDiff}
          options={{
            collapsed: false,
            diffStyle: "unified",
            theme: resolveDiffThemeName(resolvedTheme),
          }}
        />
      ))}
    </div>
  );
}

function WorkerRefreshedFileDiff(props: ComponentProps<typeof FileDiff>) {
  const workerPool = useWorkerPool();
  const subscribe = useCallback(
    (listener: () => void) => workerPool?.subscribeToStatChanges(listener) ?? (() => {}),
    [workerPool],
  );
  const getSnapshot = useCallback(
    () => workerPool?.getDiffResultCache(props.fileDiff) !== undefined,
    [props.fileDiff, workerPool],
  );
  const highlightCached = useSyncExternalStore(subscribe, getSnapshot, () => false);
  const renderKey = props.fileDiff.cacheKey
    ? `${props.fileDiff.cacheKey}:${highlightCached ? "highlighted" : "pending"}`
    : undefined;
  return <FileDiff {...props} key={renderKey} />;
}
