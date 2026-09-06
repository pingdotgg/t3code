import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ArrowDownIcon } from "lucide-react";
import { useMemo, useRef } from "react";
import { Button } from "~/components/ui/button";
import { useThreadShells } from "~/state/entities";

/** Keeps all pending questions reachable, including threads in collapsed lists. */
export function SidebarQuestionIndicators({
  onNavigate,
}: {
  onNavigate: (threadRef: ScopedThreadRef) => void;
}) {
  const threads = useThreadShells();
  const pending = useMemo(
    () =>
      threads
        .filter((thread) => thread.archivedAt === null && thread.hasPendingUserInput)
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
    [threads],
  );
  const lastTarget = useRef<string | null>(null);
  const count = pending.length;

  return (
    <div className="shrink-0 px-2 pb-2">
      <Button
        variant="outline"
        size="sm"
        disabled={count === 0}
        aria-label={`Next pending question (${count})`}
        className="w-full justify-between border-indigo-400/50 bg-sidebar text-indigo-600 transition-none active:scale-100 dark:bg-sidebar dark:text-indigo-300 [--control-icon-color:currentColor]"
        onClick={() => {
          const nextIndex =
            (pending.findIndex((ref) => scopedThreadKey(ref) === lastTarget.current) + 1) % count;
          const next = pending[nextIndex];
          if (!next) return;
          lastTarget.current = scopedThreadKey(next);
          onNavigate(next);
        }}
      >
        <span>
          Needs input · <span className="tabular-nums">{count}</span>
        </span>
        <ArrowDownIcon aria-hidden="true" className="size-4" />
      </Button>
    </div>
  );
}
