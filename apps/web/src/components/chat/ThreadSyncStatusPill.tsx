import { LoaderCircleIcon } from "lucide-react";

import { threadSyncLabel, type ThreadSyncPhase } from "../../threadSync";

export function ThreadSyncStatusPill({ phase }: { readonly phase: ThreadSyncPhase }) {
  const label = threadSyncLabel(phase);

  return (
    <div
      aria-label={label}
      className="pointer-events-none mx-auto mb-2 flex w-fit max-w-full items-center gap-2 rounded-full border border-border/60 bg-card/95 px-3 py-1.5 text-foreground text-xs font-medium shadow-sm"
      role="status"
    >
      <LoaderCircleIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </div>
  );
}
