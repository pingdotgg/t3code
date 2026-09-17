import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import { THREAD_SUBAGENT_STATUS_LABELS } from "@t3tools/client-runtime/state/thread-subagents";
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

/** Place the toggle inside the thread row and its tree immediately after the row. */
export function useSidebarSubagents(thread: EnvironmentThreadShell, compact = false) {
  const [expandedThread, setExpandedThread] = useState<string | null>(null);
  const key = `${thread.environmentId}:${thread.id}`;
  const expanded = expandedThread === key;
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
      <InlineButton
        data-thread-selection-safe
        aria-expanded={expanded}
        aria-controls={treeId}
        aria-label={`Subagents for ${thread.title}: ${model.label}`}
        title={`Subagents: ${model.label}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setExpandedThread(expanded ? null : key);
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.stopPropagation();
        }}
        className="gap-1 text-[11px] tabular-nums text-muted-foreground hover:text-foreground"
      >
        <BotIcon aria-hidden className="size-3" />
        {compact ? (
          <>
            <CircleDotIcon aria-hidden className="size-2.5 text-info" />
            <span>{model.running}</span>
            <CheckIcon aria-hidden className="size-2.5" />
            <span>{model.finished}</span>
          </>
        ) : (
          <>
            <span className={model.running > 0 ? "text-info" : undefined}>
              {model.running} running
            </span>
            <span aria-hidden>·</span>
            <span>{model.finished} finished</span>
          </>
        )}
        <ChevronDownIcon aria-hidden className={cn("size-3", expanded && "rotate-180")} />
      </InlineButton>
    ),
    tree: (
      <ul
        id={treeId}
        aria-label={`Subagents for ${thread.title}`}
        hidden={!expanded}
        className="mx-[var(--sidebar-row-content-inset,0.625rem)] mb-1 border-l border-border/60"
      >
        {expanded
          ? model.rows.map(({ thread: agent, depth, status }) => (
              <li
                key={agent.id}
                className="relative flex min-w-0 items-center gap-1.5 py-1 text-xs before:absolute before:top-1/2 before:left-0 before:w-2 before:border-t before:border-border/60"
                style={{ paddingLeft: (Math.min(depth, 4) + 1) * 12 }}
              >
                <span
                  aria-hidden
                  className={cn("size-1.5 shrink-0 rounded-full bg-current", statusClass(status))}
                />
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
              </li>
            ))
          : null}
      </ul>
    ),
  };
}
