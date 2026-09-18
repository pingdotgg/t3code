import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import {
  THREAD_SUBAGENT_STATUS_LABELS,
  visibleThreadSubagentRows,
  type ThreadSubagentCounts,
} from "@t3tools/client-runtime/state/thread-subagents";
import type { ThreadId } from "@t3tools/contracts";
import { BotIcon, CheckIcon, ChevronDownIcon, CircleDotIcon } from "lucide-react";
import { useId, useState } from "react";
import { environmentThreadShells } from "../state/threads";
import { cn } from "~/lib/utils";
import { InlineButton } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function statusClass(status: keyof typeof THREAD_SUBAGENT_STATUS_LABELS) {
  if (
    status === "running" ||
    status === "preparing" ||
    status === "starting" ||
    status === "queued"
  )
    return "text-info";
  if (status === "waiting") return "text-warning";
  if (status === "completed") return "text-success";
  if (status === "failed") return "text-destructive";
  return "text-muted-foreground";
}

/** Show root counts or an inline disclosure for a nested branch. */
function SubagentToggle({
  thread,
  counts,
  expanded,
  onToggle,
  compact = false,
  disclosureOnly = false,
  treeId,
}: {
  thread: EnvironmentThreadShell;
  counts: ThreadSubagentCounts;
  expanded: boolean;
  onToggle: () => void;
  compact?: boolean;
  disclosureOnly?: boolean;
  treeId?: string;
}) {
  return (
    <InlineButton
      data-thread-selection-safe
      aria-expanded={expanded}
      aria-controls={treeId}
      aria-label={`Subagents for ${thread.title}: ${counts.label}`}
      title={`Subagents: ${counts.label}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
      className="gap-1 text-[11px] tabular-nums text-muted-foreground hover:text-foreground"
    >
      {disclosureOnly ? null : (
        <>
          <BotIcon aria-hidden className="size-3" />
          {compact ? (
            <>
              <CircleDotIcon aria-hidden className="size-2.5 text-info" />
              <span>{counts.running}</span>
              <CheckIcon aria-hidden className="size-2.5" />
              <span>{counts.finished}</span>
            </>
          ) : (
            <>
              <span className={counts.running > 0 ? "text-info" : undefined}>
                {counts.running} running
              </span>
              <span aria-hidden>·</span>
              <span>{counts.finished} finished</span>
            </>
          )}
        </>
      )}
      <ChevronDownIcon aria-hidden className={cn("size-3", expanded && "rotate-180")} />
    </InlineButton>
  );
}

/** Place the toggle inside the thread row and its tree immediately after the row. */
export function useSidebarSubagents(thread: EnvironmentThreadShell, compact = false) {
  const key = `${thread.environmentId}:${thread.id}`;
  const [expansion, setExpansion] = useState(() => ({ key, ids: new Set<ThreadId>() }));
  const expandedIds = expansion.key === key ? expansion.ids : new Set<ThreadId>();
  const expanded = expandedIds.has(thread.id);
  const toggleThread = (id: ThreadId) => {
    setExpansion((current) => {
      const ids = new Set(current.key === key ? current.ids : []);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { key, ids };
    });
  };
  const treeId = useId();
  const model = useAtomValue(
    environmentThreadShells.subagentTreeAtom({
      environmentId: thread.environmentId,
      threadId: thread.id,
    }),
  );
  if (model.rows.length === 0) return { toggle: null, tree: null };

  return {
    toggle: (
      <SubagentToggle
        thread={thread}
        counts={model}
        expanded={expanded}
        onToggle={() => toggleThread(thread.id)}
        compact={compact}
        treeId={treeId}
      />
    ),
    tree: (
      <ul
        id={treeId}
        aria-label={`Subagents for ${thread.title}`}
        hidden={!expanded}
        className="mx-[var(--sidebar-row-content-inset,0.625rem)] mb-1 border-l border-border/60"
      >
        {expanded
          ? visibleThreadSubagentRows(model.rows, expandedIds).map(
              ({ thread: agent, depth, status, descendants }) => (
                <li
                  key={agent.id}
                  aria-level={depth + 1}
                  className="relative min-w-0 py-1 text-xs before:absolute before:top-3 before:left-0 before:w-2 before:border-t before:border-border/60"
                  style={{ paddingLeft: (Math.min(depth, 4) + 1) * 12 }}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    {descendants.total > 0 ? (
                      <SubagentToggle
                        thread={agent}
                        counts={descendants}
                        expanded={expandedIds.has(agent.id)}
                        onToggle={() => toggleThread(agent.id)}
                        disclosureOnly
                      />
                    ) : (
                      <span
                        aria-hidden
                        className="inline-flex size-3 shrink-0 items-center justify-center"
                      >
                        <span
                          className={cn("size-1.5 rounded-full bg-current", statusClass(status))}
                        />
                      </span>
                    )}
                    <Tooltip>
                      <TooltipTrigger
                        render={<span className="min-w-0 flex-1 truncate text-secondary-label" />}
                      >
                        {agent.title}
                      </TooltipTrigger>
                      <TooltipPopup>{agent.title}</TooltipPopup>
                    </Tooltip>
                    <span className={cn("shrink-0 text-[10px]", statusClass(status))}>
                      {THREAD_SUBAGENT_STATUS_LABELS[status]}
                    </span>
                  </div>
                </li>
              ),
            )
          : null}
      </ul>
    ),
  };
}
