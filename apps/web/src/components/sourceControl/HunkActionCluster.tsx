/**
 * The per-hunk Stage / Unstage / Discard cluster rendered inside the existing
 * diff view.
 *
 * It is deliberately dumb: no data, no atoms, no busy bookkeeping of its own.
 * Everything it needs arrives as props so the diff can re-render it without
 * re-rendering (or re-laying out) a single line of code.
 *
 * fork: f4 hunk staging
 */
import { CheckIcon, Loader2Icon, Trash2Icon, UndoIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import {
  hunkActionLabel,
  type HunkAction,
  type HunkCluster,
  type HunkSide,
} from "~/lib/sourceControl/hunkActions";

function actionIcon(action: HunkAction) {
  switch (action) {
    case "stage":
      return <CheckIcon aria-hidden="true" className="size-3" />;
    case "unstage":
      return <UndoIcon aria-hidden="true" className="size-3" />;
    case "discard":
      return <Trash2Icon aria-hidden="true" className="size-3" />;
  }
}

export function HunkActionCluster(props: {
  readonly cluster: HunkCluster;
  readonly side: HunkSide;
  readonly actions: ReadonlyArray<HunkAction>;
  readonly pendingAction: HunkAction | null;
  readonly disabled: boolean;
  readonly onAction: (action: HunkAction, cluster: HunkCluster) => void;
}) {
  const { cluster } = props;
  return (
    <div
      className="flex items-center gap-2 border-border/60 border-y bg-muted/40 px-2 py-1 font-sans text-[11px]"
      data-hunk-actions={cluster.index}
    >
      <span className="truncate font-mono text-muted-foreground/80">{cluster.label}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground/70">
        <span className="text-[var(--diffs-addition-base)]">+{cluster.additions}</span>{" "}
        <span className="text-[var(--diffs-deletion-base)]">-{cluster.deletions}</span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {props.actions.map((action) => {
          const pending = props.pendingAction === action;
          return (
            <button
              key={action}
              type="button"
              // Every rung here is either its own inverse (stage/unstage) or
              // confirmed upstream (discard), so the button itself stays plain.
              className={cn(
                "inline-flex h-5 cursor-pointer items-center gap-1 rounded-sm border border-border bg-background/70 px-1.5 transition-colors",
                "hover:bg-accent disabled:cursor-default disabled:opacity-50",
                action === "discard" && "text-destructive hover:bg-destructive/10",
              )}
              disabled={props.disabled}
              aria-label={`${hunkActionLabel(action)} ${cluster.label}`}
              onClick={() => props.onAction(action, cluster)}
            >
              {pending ? (
                <Loader2Icon aria-hidden="true" className="size-3 animate-spin" />
              ) : (
                actionIcon(action)
              )}
              <span>{hunkActionLabel(action)}</span>
            </button>
          );
        })}
      </span>
    </div>
  );
}
