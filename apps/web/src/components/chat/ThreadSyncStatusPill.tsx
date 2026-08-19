import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { threadSyncLabel, type ThreadSyncPhase } from "../../threadSync";

export function ThreadSyncStatusPill({
  phase,
  raised,
}: {
  readonly phase: ThreadSyncPhase;
  readonly raised: boolean;
}) {
  const [syncingVisible, setSyncingVisible] = useState(phase === "loading");

  useEffect(() => {
    if (phase !== "syncing") return;
    const timeoutId = globalThis.setTimeout(() => setSyncingVisible(true), 300);
    return () => globalThis.clearTimeout(timeoutId);
  }, [phase]);

  if (phase === "syncing" && !syncingVisible) return null;

  const label = threadSyncLabel(phase);

  return (
    <div
      aria-label={label}
      className="pointer-events-none absolute left-1/2 flex w-fit max-w-full -translate-x-1/2 items-center gap-2 rounded-full border border-border/60 bg-card/95 px-3 py-1.5 text-foreground text-xs font-medium shadow-sm"
      role="status"
      style={{ bottom: raised ? "calc(100% + 2.75rem)" : "calc(100% + 0.5rem)" }}
    >
      <LoaderCircleIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </div>
  );
}
