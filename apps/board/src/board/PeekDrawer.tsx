import type { EnvironmentId } from "@t3tools/contracts";
import { X } from "lucide-react";

import type { BoardModel } from "../state/boardModel";
import type { Peek } from "../state/boardUi";
import { AgentLog } from "./AgentLog";
import { DrawerReadiness } from "./DrawerReadiness";
import { PrChecks } from "./PrChecks";

const STATE_LABEL = {
  working: "Working",
  waiting: "Waiting",
  idle: "Idle",
  failed: "Failed",
  stopped: "Stopped",
} as const;

/** A ticket's summary and why, and the log of the agent chosen on its frame or in the sidebar. */
export function PeekDrawer({
  environmentId,
  model,
  peek,
  onClose,
}: {
  environmentId: EnvironmentId;
  model: BoardModel;
  peek: Peek | null;
  onClose: () => void;
}) {
  if (peek === null) return null;
  const view = Object.values(model.lanes)
    .flat()
    .find(
      (entry) =>
        entry.ticket.key === peek.ticketKey ||
        entry.agents.some((agent) => agent.threadId === peek.threadId),
    );
  const agent =
    [...(view?.agents ?? []), ...model.unassigned].find((a) => a.threadId === peek.threadId) ??
    null;
  if (view === undefined && agent === null) return null;
  const ticket = view?.ticket;
  return (
    <aside
      aria-label="Peek"
      data-testid="peek-drawer"
      className="absolute inset-y-0 right-0 z-20 flex w-[360px] flex-col border-l border-line bg-sidebar shadow-panel"
    >
      <header className="flex items-start gap-2 border-b border-line px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold">
            {ticket === undefined ? "Unassigned" : `${ticket.key} ${ticket.title}`}
          </h3>
          {agent !== null && (
            <p className="text-[11px] text-muted">
              {agent.role} · {STATE_LABEL[agent.runState]}
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label="Close peek"
          onClick={onClose}
          className="grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
        >
          <X className="size-4" />
        </button>
      </header>
      {ticket !== undefined && (
        <dl className="space-y-1 border-b border-line px-3 py-2 text-[12px]">
          <div>
            <dt className="text-[10px] text-faint uppercase">Summary</dt>
            <dd data-testid="peek-summary" className="break-words text-fg">
              {ticket.summary ?? "No summary yet"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] text-faint uppercase">Why</dt>
            <dd data-testid="peek-why" className="break-words text-fg">
              {ticket.why ?? "No reason yet"}
            </dd>
          </div>
        </dl>
      )}
      {view !== undefined && (
        <div className="max-h-[50%] shrink-0 overflow-y-auto">
          <PrChecks view={view} />
          <DrawerReadiness view={view} />
        </div>
      )}
      {agent === null ? (
        <p className="px-3 py-3 text-faint">Select an agent card to read its thread.</p>
      ) : (
        <AgentLog key={agent.threadId} environmentId={environmentId} agent={agent} />
      )}
    </aside>
  );
}
