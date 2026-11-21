import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type CrewStatus,
  crewStatus,
  foldedCrewSummary,
  type ThreadGroup,
  visibleCrew,
} from "@t3tools/client-runtime/state/thread-grouping";
import type { ContextMenuSource, ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { BellOffIcon, ChevronRightIcon } from "lucide-react";
import { memo } from "react";

import { contextMenuSourceOf } from "../../contextMenuSource";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useThreadShell } from "../../state/entities";
import { cn } from "~/lib/utils";

const STATUS_DOT: Record<CrewStatus, string> = {
  "needs-input": "bg-warning",
  working: "bg-info",
  idle: "bg-muted-foreground/40",
};

// More crew than this reads as a count; dots past it add width without information.
const MAX_DOTS = 8;

function CrewRow(props: {
  thread: EnvironmentThreadShell;
  isActive: boolean;
  onNavigate: (threadRef: ScopedThreadRef) => void;
  onContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const threadRef = scopeThreadRef(props.thread.environmentId, props.thread.id);
  const thread = useThreadShell(threadRef) ?? props.thread;
  const status = crewStatus(thread);
  return (
    <li role="presentation" className="list-none">
      <button
        type="button"
        aria-current={props.isActive ? "page" : undefined}
        onClick={() => props.onNavigate(threadRef)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(
            threadRef,
            { x: event.clientX, y: event.clientY },
            contextMenuSourceOf(event),
          );
        }}
        className={cn(
          "flex h-7 w-full min-w-0 items-center gap-2 rounded-md pr-2.5 pl-7 text-left text-xs outline-none",
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
      >
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])} />
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      </button>
    </li>
  );
}

/** The crew under a leader's row: a fold toggle, then every member or only those needing input. */
export const SidebarCrewBlock = memo(function SidebarCrewBlock(props: {
  leaderKey: string;
  group: ThreadGroup<EnvironmentThreadShell>;
  folded: boolean;
  routeThreadKey: string | null;
  onToggle: (leaderKey: string, folded: boolean) => void;
  onNavigate: (threadRef: ScopedThreadRef) => void;
  onContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const gt = useGT();
  const summary = foldedCrewSummary(props.group);
  const rows = visibleCrew(props.group, props.folded);
  return (
    <>
      <li role="presentation" className="list-none">
        <button
          type="button"
          aria-expanded={!props.folded}
          onClick={() => props.onToggle(props.leaderKey, props.folded)}
          className="flex h-6 w-full items-center gap-1.5 rounded-md pr-2.5 pl-5 text-left text-xs text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3 shrink-0", !props.folded && "rotate-90")}
          />
          <span>
            {gt("{count, plural, one {{count} crew} other {{count} crew}}", {
              count: summary.count,
            })}
          </span>
          {props.group.muted ? (
            <BellOffIcon aria-label={gt("Crew muted")} className="size-3 shrink-0" />
          ) : null}
          <span aria-hidden className="ml-auto flex items-center gap-0.5">
            {summary.statuses.slice(0, MAX_DOTS).map((status, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- dots are identical per status and never reorder in place
              <span key={index} className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
            ))}
          </span>
        </button>
      </li>
      {rows.map((thread) => {
        const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        return (
          <CrewRow
            key={key}
            thread={thread}
            isActive={props.routeThreadKey === key}
            onNavigate={props.onNavigate}
            onContextMenu={props.onContextMenu}
          />
        );
      })}
    </>
  );
});
