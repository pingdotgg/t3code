import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { markTicketPainted, ticketChoiceAtom } from "../browser/panel";
import { EmptyFiles } from "../files/EmptyFiles";
import type { BoardModel } from "../state/boardModel";
import { AgentLog } from "./AgentLog";
import { PrChecks } from "./PrChecks";
import { TicketReadiness } from "./TicketReadiness";

const STATE_LABEL = {
  working: "Working",
  waiting: "Waiting",
  idle: "Idle",
  failed: "Failed",
  stopped: "Stopped",
} as const;

/** The Ticket tab: a ticket's summary and why, and the log of the agent chosen on its frame or in the sidebar. The board's screen draws it into the panel. */
export function TicketPanel({
  environmentId,
  model,
}: {
  environmentId: EnvironmentId;
  model: BoardModel;
}) {
  const choice = useAtomValue(ticketChoiceAtom);
  // A new function each render, so the frame after every render marks a pending open as painted.
  const markPainted = (element: HTMLElement | null) => {
    if (element !== null) requestAnimationFrame(() => markTicketPainted());
  };
  const view =
    choice === null
      ? undefined
      : Object.values(model.lanes)
          .flat()
          .find(
            (entry) =>
              entry.ticket.key === choice.ticketKey ||
              entry.agents.some((agent) => agent.threadId === choice.threadId),
          );
  const agent =
    choice === null
      ? null
      : ([...(view?.agents ?? []), ...model.unassigned].find(
          (a) => a.threadId === choice.threadId,
        ) ?? null);
  if (view === undefined && agent === null) {
    return (
      <div ref={markPainted} className="flex min-h-0 flex-1 flex-col">
        <EmptyFiles>Select a ticket or agent card</EmptyFiles>
      </div>
    );
  }
  const ticket = view?.ticket;
  return (
    <div ref={markPainted} className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-line px-3 py-2.5">
        <h3 className="truncate font-semibold">
          {ticket === undefined ? "Unassigned" : `${ticket.key} ${ticket.title}`}
        </h3>
        {agent !== null && (
          <p className="text-[11px] text-muted">
            {agent.role} · {STATE_LABEL[agent.runState]}
          </p>
        )}
      </header>
      {ticket !== undefined && (
        <dl className="space-y-1 border-b border-line px-3 py-2 text-[12px]">
          <div>
            <dt className="text-[10px] text-faint uppercase">Summary</dt>
            <dd data-testid="ticket-summary" className="break-words text-fg">
              {ticket.summary ?? "No summary yet"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] text-faint uppercase">Why</dt>
            <dd data-testid="ticket-why" className="break-words text-fg">
              {ticket.why ?? "No reason yet"}
            </dd>
          </div>
        </dl>
      )}
      {view !== undefined && (
        <div className="max-h-[50%] shrink-0 overflow-y-auto">
          <PrChecks view={view} />
          <TicketReadiness view={view} />
        </div>
      )}
      {agent === null ? (
        <p className="px-3 py-3 text-faint">Select an agent card to read its thread.</p>
      ) : (
        <AgentLog key={agent.threadId} environmentId={environmentId} agent={agent} />
      )}
    </div>
  );
}
