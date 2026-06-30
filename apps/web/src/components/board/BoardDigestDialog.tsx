import type { WorkflowBoardDigest } from "@t3tools/contracts";
import { NewspaperIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { formatDuration } from "~/session-logic";
import { formatTokenCount } from "~/workflow/usageFormat";

/**
 * The board's stand-up summary: what moved, what shipped, what it cost, and
 * which tickets have been waiting on a human the longest.
 */
export function BoardDigestDialog({
  disabled,
  needsAttentionCount,
  onFetchDigest,
  open: controlledOpen,
  onOpenChange,
}: {
  readonly disabled: boolean;
  readonly needsAttentionCount: number;
  readonly onFetchDigest: () => Promise<WorkflowBoardDigest>;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const isControlled = onOpenChange !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = isControlled ? (controlledOpen ?? false) : uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (isControlled) {
      onOpenChange(next);
    } else {
      setUncontrolledOpen(next);
    }
  };
  const [digest, setDigest] = useState<WorkflowBoardDigest | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A close (or re-open) invalidates in-flight fetches so a slow response
  // can never repopulate the dialog with stale content.
  const requestRef = useRef(0);

  const load = async () => {
    const requestId = ++requestRef.current;
    setError(null);
    setDigest(null);
    try {
      const next = await onFetchDigest();
      if (requestRef.current === requestId) {
        setDigest(next);
      }
    } catch (cause) {
      if (requestRef.current === requestId) {
        setError(cause instanceof Error ? cause.message : "Failed to load the digest.");
      }
    }
  };

  // In controlled mode the parent owns the trigger, so the load the
  // self-contained trigger's onClick performed must fire when the dialog
  // transitions to open.
  useEffect(() => {
    if (isControlled && open && digest === null && error === null) {
      void load();
    }
  }, [isControlled, open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          requestRef.current += 1;
          setDigest(null);
        }
      }}
    >
      {isControlled ? null : (
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={disabled}
          title="What happened on this board in the last 24 hours"
          onClick={() => {
            // onOpenChange only fires for internal open changes (Esc,
            // backdrop) — a controlled setOpen must kick off its own load.
            setOpen(true);
            void load();
          }}
        >
          <NewspaperIcon className="size-3.5" />
          Digest
          {needsAttentionCount > 0 ? (
            <Badge size="sm" variant="warning" data-testid="board-needs-attention-count">
              {needsAttentionCount}
            </Badge>
          ) : null}
        </Button>
      )}
      <DialogPopup className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-hidden">
        <div className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Board digest</DialogTitle>
            <DialogDescription>
              The last {digest?.windowHours ?? 24} hours on this board.
            </DialogDescription>
          </DialogHeader>
          <div
            className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pt-1 pb-4"
            data-testid="board-digest"
          >
            {error !== null ? (
              <p className="text-xs text-destructive-foreground" role="alert">
                {error}
              </p>
            ) : digest === null ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <>
                <dl className="grid grid-cols-2 gap-3">
                  <div className="rounded-md border border-border/70 bg-card/35 p-3">
                    <dt className="text-xs text-muted-foreground">Shipped</dt>
                    <dd className="text-lg font-semibold text-foreground">{digest.shippedCount}</dd>
                  </div>
                  <div className="rounded-md border border-border/70 bg-card/35 p-3">
                    <dt className="text-xs text-muted-foreground">Created</dt>
                    <dd className="text-lg font-semibold text-foreground">{digest.createdCount}</dd>
                  </div>
                  <div className="rounded-md border border-border/70 bg-card/35 p-3">
                    <dt className="text-xs text-muted-foreground">Tokens spent</dt>
                    <dd className="text-lg font-semibold text-foreground">
                      {digest.totalTokens > 0 ? formatTokenCount(digest.totalTokens) : "0"}
                    </dd>
                  </div>
                  <div className="rounded-md border border-border/70 bg-card/35 p-3">
                    <dt className="text-xs text-muted-foreground">Agent time</dt>
                    <dd className="text-lg font-semibold text-foreground">
                      {digest.totalDurationMs > 0 ? formatDuration(digest.totalDurationMs) : "0"}
                    </dd>
                  </div>
                </dl>
                <section>
                  <h3 className="mb-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Waiting on you
                  </h3>
                  {digest.needsAttention.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Nothing — the board is running itself.
                    </p>
                  ) : (
                    <ol className="space-y-1.5">
                      {digest.needsAttention.map((ticket) => (
                        <li
                          key={ticket.ticketId as string}
                          className="flex items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/5 px-2.5 py-1.5"
                        >
                          <span className="min-w-0 truncate text-sm text-foreground">
                            {ticket.title}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {ticket.status === "blocked" ? "blocked" : "waiting"} ·{" "}
                            {formatDuration(ticket.sinceMs)}
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              </>
            )}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
