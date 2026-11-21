import { GitBranch, LoaderCircle, MessageCircleQuestion, TriangleAlert } from "lucide-react";

import type { Ticket } from "../domain/ticket";
import type { AgentView, RunState } from "../state/boardModel";
import { usePrContext } from "../state/prStatus";
import { Tooltip } from "../ui/Tooltip";
import { ProviderGlyph } from "../usage/ProviderGlyph";
import { CARD_HEIGHT } from "./layout";
import { SetupFailure, useSetupLine } from "./SetupLine";
import { ReviewChanges } from "./ReviewChanges";

const STATE = {
  working: { label: "Working", chip: "bg-sky-500/15 text-sky-300", accent: "bg-sky-400" },
  waiting: { label: "Waiting", chip: "bg-amber-500/15 text-amber-300", accent: "bg-amber-400" },
  idle: { label: "Idle", chip: "bg-hover text-muted", accent: "bg-faint" },
  failed: { label: "Failed", chip: "bg-red-500/15 text-red-300", accent: "bg-red-400" },
  stopped: { label: "Stopped", chip: "bg-hover text-muted", accent: "bg-faint" },
} as const satisfies Record<RunState, { label: string; chip: string; accent: string }>;

/** One agent on a ticket: its role, where it runs, what state its run is in, and whether it waits on the user. */
export function AgentCard({
  agent,
  ticket,
  selected,
  onOpen,
}: {
  agent: AgentView;
  /** The ticket the agent works on, or undefined for an agent no ticket claims. */
  ticket?: Ticket;
  selected: boolean;
  onOpen: () => void;
}) {
  const state = STATE[agent.runState];
  const environmentId = usePrContext().project.environmentId;
  const setup = useSetupLine(environmentId, agent.threadId);
  return (
    <div className="relative" style={{ height: CARD_HEIGHT }}>
      <button
        type="button"
        data-testid="agent-card"
        data-role={agent.role}
        data-state={agent.runState}
        data-registered={agent.registered}
        data-outside-registry={agent.outsideRegistry}
        aria-label={`${agent.role} agent, ${state.label.toLowerCase()}`}
        aria-pressed={selected}
        // A press that starts on a card is a click, not the start of a pan.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onOpen}
        className={`relative flex h-full w-full flex-col justify-center gap-1 overflow-hidden rounded-md border bg-bg py-1.5 pr-2 pl-3 text-left hover:bg-hover ${selected ? "border-focus" : "border-line"}`}
      >
        <span className={`absolute inset-y-0 left-0 w-[3px] ${state.accent}`} aria-hidden />
        <span className="flex min-w-0 items-center gap-1.5">
          <ProviderGlyph driver={agent.driver ?? ""} />
          {agent.registered ? (
            <span className="min-w-0 truncate rounded bg-hover px-1.5 text-[11px] leading-[18px] font-semibold text-fg">
              {agent.role}
            </span>
          ) : (
            <Tooltip text={`${agent.role} is not a role in the registry`} side="bottom">
              <span className="min-w-0 truncate rounded border border-amber-400/50 px-1.5 text-[11px] leading-[16px] font-semibold text-amber-300">
                {agent.role}
              </span>
            </Tooltip>
          )}
          {agent.round !== null && <span className="text-[10px] text-faint">r{agent.round}</span>}
          <span className="flex-1" />
          <span className={`rounded px-1.5 text-[10px] leading-4 font-medium ${state.chip}`}>
            {state.label}
          </span>
        </span>
        {agent.pendingRequest ? (
          <span className="flex items-center gap-1 text-[11px] text-amber-300">
            <MessageCircleQuestion className="size-3 shrink-0" aria-hidden />
            Waiting on you
          </span>
        ) : agent.outsideRegistry ? (
          <span className="flex items-center gap-1 text-[11px] text-amber-300">
            <TriangleAlert className="size-3 shrink-0" aria-hidden />
            Outside the role registry
          </span>
        ) : setup !== null ? (
          <span
            data-testid="setup-line"
            className={`flex min-w-0 items-center gap-1 text-[11px] ${setup.kind === "failed" ? "text-red-300" : "text-sky-300"}`}
          >
            {setup.kind === "failed" ? (
              <TriangleAlert className="size-3 shrink-0" aria-hidden />
            ) : (
              <LoaderCircle className="size-3 shrink-0 animate-spin" aria-hidden />
            )}
            <span className="truncate">{setup.text}</span>
          </span>
        ) : (
          <span className="flex min-w-0 items-center gap-1 text-[11px] text-faint">
            <GitBranch className="size-3 shrink-0" aria-hidden />
            <span className="truncate">{agent.branch ?? "No worktree"}</span>
          </span>
        )}
      </button>
      {ticket !== undefined && (
        <span className="absolute right-1.5 bottom-1.5">
          <ReviewChanges
            ticket={ticket}
            className="grid size-5 place-items-center rounded text-faint hover:bg-hover hover:text-fg"
          />
        </span>
      )}
      {setup?.kind === "failed" && (
        <SetupFailure environmentId={environmentId} threadId={agent.threadId} line={setup} />
      )}
    </div>
  );
}
