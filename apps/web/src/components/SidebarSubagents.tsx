import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import { environmentThreadShells } from "../state/threads";
import { THREAD_SUBAGENT_STATUS_LABELS } from "@t3tools/client-runtime/state/thread-subagents";
import { BotIcon, ChevronDownIcon } from "lucide-react";
import { memo, useId, useState } from "react";
import { cn } from "~/lib/utils";
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

export const SidebarSubagents = memo(function SidebarSubagents({
  thread,
}: {
  thread: EnvironmentThreadShell;
}) {
  const [expanded, setExpanded] = useState(false);
  const treeId = useId();
  const model = useAtomValue(
    environmentThreadShells.subagentTreeAtom({
      environmentId: thread.environmentId,
      threadId: thread.id,
    }),
  );
  const threadTitle = thread.title;
  if (model.rows.length === 0) return null;

  return (
    <div
      data-thread-selection-safe
      className="px-[var(--sidebar-row-content-inset,0.625rem)] pb-1"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={treeId}
        aria-label={`Subagents for ${threadTitle}: ${model.label}`}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "grid w-full cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-x-1.5 gap-y-0.5 rounded-md border px-2 py-1.5 text-left text-[11px] outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring",
          expanded ? "border-border/70 bg-sidebar-accent/50" : "border-border/40 bg-muted/30",
        )}
      >
        <BotIcon aria-hidden className="row-span-2 size-3.5 text-muted-foreground" />
        <span className="font-medium text-secondary-label">Subagents</span>
        <span className="col-start-2 row-start-2 flex flex-wrap items-center gap-x-1 text-muted-foreground tabular-nums">
          <span className={model.running > 0 ? "text-info" : undefined}>
            {model.running} running
          </span>
          <span aria-hidden>·</span>
          <span>{model.finished} finished</span>
          {model.waiting > 0 ? <span>· {model.waiting} waiting</span> : null}
          {model.idle > 0 ? <span>· {model.idle} idle</span> : null}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "col-start-3 row-span-2 row-start-1 size-3 text-muted-foreground",
            expanded && "rotate-180",
          )}
        />
      </button>
      <ul
        id={treeId}
        aria-label={`Subagents for ${threadTitle}`}
        hidden={!expanded}
        className="ml-2 mt-1 border-l border-border/60 pl-2"
      >
        {expanded
          ? model.rows.map(({ thread: agent, depth, status }) => (
              <li
                key={agent.id}
                className="flex min-w-0 items-center gap-1.5 py-1 text-xs"
                style={{ paddingLeft: Math.min(depth, 4) * 10 }}
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
    </div>
  );
});
