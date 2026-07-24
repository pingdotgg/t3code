import type { OrchestrationThreadMonitor } from "@t3tools/contracts";
import { ExternalLinkIcon, GitMergeIcon } from "lucide-react";
import { type MouseEvent, useState } from "react";

import { cn } from "~/lib/utils";
import { resolveMonitorReadyLabel, resolveMonitorSidebarState } from "./Sidebar.logic";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";

/**
 * Thread-header strip for the PR monitoring ("babysit") mode. Lives at the top
 * of the thread while a monitor is active (mock 4b/4c):
 *
 * - monitoring → cyan strip: "Monitoring PR #n" pill, the waiting-on blockers
 *   line, and an always-visible "Stop monitoring" button.
 * - ready → emerald payoff strip: "Ready to merge" / "No known blockers" pill,
 *   the summary line, a "View PR" link and a confirm-to-merge "Merge…" button
 *   (decision D1 — never auto-merge).
 * - session-ended → subtle zinc "Monitoring stopped" marker (decision D2 floor).
 *
 * No continuous animation and no elapsed counter (a running timer reads as
 * stuck); the blockers line carries the loop's legibility instead.
 */
export function MonitorStrip({
  monitor,
  prUrl,
  onStopMonitoring,
  onOpenPr,
}: {
  monitor: OrchestrationThreadMonitor;
  prUrl: string | null;
  onStopMonitoring: () => void;
  onOpenPr: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
}) {
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);
  const state = resolveMonitorSidebarState(monitor);
  // Only the meaningful, live-ish states get a strip: an actively monitoring
  // PR, the ready payoff, or a dead-session floor marker. Terminal/user-stop/
  // needs-attention monitors hand off to the normal settled/status treatment.
  if (state === null) return null;

  const blockers = monitor.blockersSummary.trim();

  if (state === "stopped") {
    return (
      <div className="px-3 pt-2 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-muted/30 px-3 py-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <span className="size-1.5 rounded-full bg-muted-foreground/60" aria-hidden />
            Monitoring stopped
          </span>
          <span className="text-xs text-muted-foreground/70">
            PR #{monitor.prNumber} · session ended
          </span>
        </div>
      </div>
    );
  }

  const isReady = state === "ready";
  const handleOpenPr = (event: MouseEvent<HTMLElement>) => {
    if (prUrl) onOpenPr(event, prUrl);
  };

  return (
    <div className="px-3 pt-2 sm:px-5">
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border px-3 py-2",
          isReady ? "border-emerald-500/40 bg-emerald-500/[0.07]" : "border-border bg-muted/30",
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold",
              isReady
                ? "bg-emerald-500/14 text-emerald-700 dark:text-emerald-300"
                : "bg-cyan-500/12 text-cyan-700 dark:text-cyan-300",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                isReady ? "bg-emerald-500 dark:bg-emerald-400" : "bg-cyan-500 dark:bg-cyan-400",
              )}
              aria-hidden
            />
            {isReady
              ? resolveMonitorReadyLabel(monitor.blockersSummary)
              : `Monitoring PR #${monitor.prNumber}`}
          </span>
          {blockers !== "" ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">{blockers}</span>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {isReady ? (
            <>
              <Button size="xs" variant="outline" disabled={prUrl === null} onClick={handleOpenPr}>
                <ExternalLinkIcon />
                View PR
              </Button>
              <Button
                size="xs"
                variant="default"
                disabled={prUrl === null}
                onClick={() => setMergeConfirmOpen(true)}
              >
                <GitMergeIcon />
                Merge…
              </Button>
            </>
          ) : (
            <Button size="xs" variant="outline" onClick={onStopMonitoring}>
              Stop monitoring
            </Button>
          )}
        </div>
      </div>

      <AlertDialog open={mergeConfirmOpen} onOpenChange={setMergeConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge PR #{monitor.prNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              All known blockers are clear. Merging opens the pull request on your source-control
              provider to complete the merge — the decision stays with you.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            {/* TODO: there is no client-side merge mutation today (no `gh pr
                merge` path in GitActionsControl). Until the server exposes one,
                confirming opens the PR so the user completes the merge there,
                rather than inventing a new server mutation (out of P3 scope). */}
            <Button
              variant="default"
              disabled={prUrl === null}
              onClick={(event) => {
                setMergeConfirmOpen(false);
                handleOpenPr(event);
              }}
            >
              <GitMergeIcon />
              Open PR to merge
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
