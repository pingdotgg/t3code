import { type EnvironmentId, type ThreadId, type TurnId } from "@t3tools/contracts";
import { parseScopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import { Suspense, lazy, memo, useCallback, useMemo, useState } from "react";
import { XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../DiffPanelShell";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import type { DiffRouteSearch } from "../../diffRouteSearch";
import { selectThreadByRef, useStore } from "../../store";

import { GridEmptyPane } from "./GridEmptyPane";
import type { GridLayoutCell } from "./gridLayout";
import { GridPaneProvider, type GridPaneDiffRequest } from "./gridPaneContext";

const DiffPanel = lazy(() => import("../DiffPanel"));

interface GridPaneProps {
  cell: GridLayoutCell;
  cellIndex: number;
  environmentId: EnvironmentId;
  focused: boolean;
  excludedThreadKeys: ReadonlySet<string>;
  onFocus: (cellIndex: number) => void;
  onAssignThread: (cellIndex: number, threadKey: string) => void;
  onClearCell: (cellIndex: number) => void;
  onRequestNewThread: (cellIndex: number) => void;
  densityClass: string;
  compactness: "normal" | "compact" | "ultra";
}

export const GridPane = memo(function GridPane({
  cell,
  cellIndex,
  environmentId,
  focused,
  excludedThreadKeys,
  onFocus,
  onAssignThread,
  onClearCell,
  onRequestNewThread,
  densityClass,
  compactness,
}: GridPaneProps) {
  return (
    <div
      className={cn(
        "@container/grid-pane relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-card transition-[border-color]",
        focused ? "border-primary/35" : "border-border",
      )}
      onMouseDown={() => onFocus(cellIndex)}
      onFocus={() => onFocus(cellIndex)}
      data-grid-pane-index={cellIndex}
      data-grid-pane-focused={focused ? "true" : undefined}
    >
      {cell.threadKey ? (
        <PopulatedPane
          threadKey={cell.threadKey}
          environmentId={environmentId}
          onClearCell={() => onClearCell(cellIndex)}
          compactness={compactness}
        />
      ) : (
        <GridEmptyPane
          environmentId={environmentId}
          excludedThreadKeys={excludedThreadKeys}
          onSelectThread={(threadKey) => onAssignThread(cellIndex, threadKey)}
          onRequestNewThread={() => onRequestNewThread(cellIndex)}
          densityClass={densityClass}
        />
      )}
    </div>
  );
});

interface PopulatedPaneProps {
  threadKey: string;
  environmentId: EnvironmentId;
  onClearCell: () => void;
  compactness: "normal" | "compact" | "ultra";
}

interface PaneDiffState {
  open: boolean;
  turnId?: TurnId;
  filePath?: string;
}

function PopulatedPane({ threadKey, environmentId, onClearCell, compactness }: PopulatedPaneProps) {
  const threadRef = useMemo(() => parseScopedThreadKey(threadKey), [threadKey]);
  const threadId = threadRef?.threadId ?? null;
  const threadEnvId = threadRef?.environmentId ?? null;
  const serverThread = useStore((store) => selectThreadByRef(store, threadRef));
  const draftId = useComposerDraftStore((store) => {
    if (!threadRef) return null;
    for (const [key, draft] of Object.entries(store.draftThreadsByThreadKey)) {
      if (
        draft.environmentId === threadRef.environmentId &&
        draft.threadId === threadRef.threadId
      ) {
        return key as DraftId;
      }
    }
    return null;
  });
  const [paneDiff, setPaneDiff] = useState<PaneDiffState>({ open: false });
  const handleClosePane = useCallback(() => {
    onClearCell();
  }, [onClearCell]);
  const handleRequestDiff = useCallback((request: GridPaneDiffRequest) => {
    setPaneDiff((previous) => {
      if (!request.open) {
        return previous.open ? { open: false } : previous;
      }
      return {
        open: true,
        ...(request.turnId ? { turnId: request.turnId } : {}),
        ...(request.filePath ? { filePath: request.filePath } : {}),
      };
    });
  }, []);
  const handleCloseDiff = useCallback(() => {
    setPaneDiff({ open: false });
  }, []);
  const handleSelectTurn = useCallback((turnId: TurnId | null) => {
    setPaneDiff((previous) => {
      if (!previous.open) return previous;
      return turnId ? { open: true, turnId } : { open: true };
    });
  }, []);
  const diffSearchOverride = useMemo<DiffRouteSearch>(
    () => ({
      diff: paneDiff.open ? "1" : undefined,
      ...(paneDiff.turnId ? { diffTurnId: paneDiff.turnId } : {}),
      ...(paneDiff.filePath ? { diffFilePath: paneDiff.filePath } : {}),
    }),
    [paneDiff.filePath, paneDiff.open, paneDiff.turnId],
  );
  const scopedThreadRefForDiff = useMemo(
    () =>
      threadRef && threadId && threadEnvId
        ? scopeThreadRef(threadEnvId, threadId as ThreadId)
        : null,
    [threadEnvId, threadId, threadRef],
  );

  const isCurrentEnvironment = threadEnvId === environmentId;

  if (!threadRef || !threadId || !isCurrentEnvironment) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-background p-3 text-center text-xs text-muted-foreground">
        <p>This cell references a thread that is not in the current environment.</p>
        <Button variant="outline" size="xs" onClick={onClearCell}>
          Clear cell
        </Button>
      </div>
    );
  }

  const hasServerThread = Boolean(serverThread);
  const routeKind = hasServerThread ? "server" : draftId ? "draft" : null;

  if (routeKind === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-background p-3 text-center text-xs text-muted-foreground">
        <p>Thread not found. It may have been archived or deleted.</p>
        <Button variant="outline" size="xs" onClick={onClearCell}>
          Clear cell
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 flex-1 flex-col overflow-hidden",
        compactness === "compact" && "text-[13px]",
        compactness === "ultra" && "text-[12px]",
      )}
      data-grid-pane-content="true"
    >
      <GridPaneProvider
        onClosePane={handleClosePane}
        onRequestDiff={handleRequestDiff}
        diffOpen={paneDiff.open}
      >
        {routeKind === "server" ? (
          <ChatView
            environmentId={threadEnvId as EnvironmentId}
            threadId={threadId as ThreadId}
            reserveTitleBarControlInset={false}
            routeKind="server"
          />
        ) : draftId ? (
          <ChatView
            environmentId={threadEnvId as EnvironmentId}
            threadId={threadId as ThreadId}
            reserveTitleBarControlInset={false}
            routeKind="draft"
            draftId={draftId}
          />
        ) : null}
      </GridPaneProvider>
      {paneDiff.open && scopedThreadRefForDiff ? (
        <div className="absolute inset-0 z-30 flex flex-col overflow-hidden bg-background/80 backdrop-blur">
          <div className="flex items-center justify-between border-b border-border bg-card px-3 py-1.5">
            <div className="text-xs font-medium text-foreground">Diff</div>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleCloseDiff}
              aria-label="Close diff panel"
            >
              <XIcon className="size-3" />
            </Button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <DiffWorkerPoolProvider>
              <Suspense fallback={<GridPaneDiffLoading mode="inline" />}>
                <DiffPanel
                  mode="inline"
                  threadRefOverride={scopedThreadRefForDiff}
                  diffSearchOverride={diffSearchOverride}
                  onSelectTurnOverride={handleSelectTurn}
                />
              </Suspense>
            </DiffWorkerPoolProvider>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GridPaneDiffLoading({ mode }: { mode: DiffPanelMode }) {
  return (
    <DiffPanelShell mode={mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label="Loading diff viewer..." />
    </DiffPanelShell>
  );
}
