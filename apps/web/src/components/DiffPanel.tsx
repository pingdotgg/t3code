import { PatchDiff } from "@pierre/diffs/react";
import { XIcon } from "lucide-react";
import { useMemo } from "react";
import { isElectron } from "../env";
import { deriveTurnDiffSummaries, formatTimestamp } from "../session-logic";
import { useStore } from "../store";
import { Button } from "./ui/button";
import { cn } from "~/lib/utils";

export default function DiffPanel() {
  const { state, dispatch } = useStore();
  const activeThread = state.threads.find((thread) => thread.id === state.activeThreadId);
  const turnDiffSummaries = useMemo(
    () => deriveTurnDiffSummaries(activeThread?.events ?? []),
    [activeThread?.events],
  );

  const canApplyStoredTarget = Boolean(activeThread && state.diffThreadId === activeThread.id);
  const selectedTurnId = canApplyStoredTarget ? state.diffTurnId : null;
  const selectedFilePath = canApplyStoredTarget ? state.diffFilePath : null;
  const selectedTurn =
    turnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ?? turnDiffSummaries[0];
  const selectedFile =
    selectedTurn?.files.find((file) => file.path === selectedFilePath) ?? selectedTurn?.files[0];
  const selectedPatch = selectedFile?.diff ?? selectedTurn?.unifiedDiff;

  const selectTurn = (turnId: string) => {
    if (!activeThread) return;
    const turn = turnDiffSummaries.find((summary) => summary.turnId === turnId);
    dispatch({
      type: "SET_DIFF_TARGET",
      threadId: activeThread.id,
      turnId,
      ...(turn?.files[0]?.path ? { filePath: turn.files[0].path } : {}),
    });
  };

  const selectFile = (filePath: string) => {
    if (!activeThread || !selectedTurn) return;
    dispatch({
      type: "SET_DIFF_TARGET",
      threadId: activeThread.id,
      turnId: selectedTurn.turnId,
      filePath,
    });
  };

  return (
    <aside className="flex h-full w-[560px] shrink-0 flex-col border-l border-border bg-card">
      <div
        className={cn(
          "flex items-center justify-between border-b border-border px-4",
          isElectron ? "drag-region h-[52px]" : "py-3",
        )}
      >
        <h3 className="text-xs font-medium text-foreground">Turn diffs</h3>
        <Button type="button" size="icon-xs" variant="ghost" onClick={() => dispatch({ type: "CLOSE_DIFF" })}>
          <XIcon />
        </Button>
      </div>

      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : turnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turn file changes yet.
        </div>
      ) : (
        <>
          <div className="border-b border-border px-3 py-2.5">
            <p className="mb-1.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
              Turns
            </p>
            <div className="flex flex-wrap gap-1.5">
              {turnDiffSummaries.map((summary, index) => (
                <button
                  key={summary.turnId}
                  type="button"
                  className={cn(
                    "rounded-md border px-2 py-1 text-left transition-colors",
                    summary.turnId === selectedTurn?.turnId
                      ? "border-border bg-accent text-accent-foreground"
                      : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
                  )}
                  onClick={() => selectTurn(summary.turnId)}
                  title={summary.turnId}
                >
                  <div className="text-[10px] font-medium">Turn {turnDiffSummaries.length - index}</div>
                  <div className="text-[10px] opacity-70">{formatTimestamp(summary.completedAt)}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex flex-1">
            <div className="w-[220px] shrink-0 border-r border-border px-2 py-2">
              <p className="mb-1.5 px-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
                Files
              </p>
              <div className="space-y-1 overflow-y-auto">
                {selectedTurn?.files.map((file) => (
                  <button
                    key={`${selectedTurn.turnId}:${file.path}`}
                    type="button"
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left font-mono text-[11px] transition-colors",
                      selectedFile?.path === file.path
                        ? "border-border bg-accent text-accent-foreground"
                        : "border-border/60 bg-background/60 text-muted-foreground/85 hover:border-border hover:text-foreground/90",
                    )}
                    onClick={() => selectFile(file.path)}
                  >
                    <span className="truncate">{file.path}</span>
                    {file.kind && (
                      <span className="rounded-sm border border-border/60 px-1 py-0.5 text-[9px] uppercase tracking-[0.08em]">
                        {file.kind}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="min-w-0 flex-1 overflow-auto px-3 py-2">
              {!canApplyStoredTarget && state.diffThreadId && (
                <p className="mb-2 text-[11px] text-muted-foreground/65">
                  Showing diffs for the active thread.
                </p>
              )}
              {!selectedPatch ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground/70">
                  No patch available for this selection.
                </div>
              ) : (
                <PatchDiff patch={selectedPatch} />
              )}
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
