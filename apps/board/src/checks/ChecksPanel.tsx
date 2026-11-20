import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { ChevronDown, GitBranch } from "lucide-react";
import { useContext } from "react";

import { panelAtom } from "../browser/panel";
import { EmptyFiles } from "../files/EmptyFiles";
import { trimSlashes } from "../files/target";
import { checksTicketAtom } from "../state/checksView";
import { filesViewAtom } from "../state/filesView";
import { usePrContext } from "../state/prStatus";
import { TicketChecks } from "./TicketChecks";

/**
 * The Checks tab: the pull request of one ticket. It follows the root chosen in the explorer and
 * Source Control, and the picker names another ticket. The board's screen draws it into the panel.
 */
export function ChecksPanel() {
  const registry = useContext(RegistryContext);
  const { tickets } = usePrContext();
  const root = useAtomValue(filesViewAtom).root;
  const chosen = useAtomValue(checksTicketAtom);
  const { open, tab } = useAtomValue(panelAtom);
  const view =
    tickets.find((entry) => entry.ticket.key === chosen) ??
    tickets.find(
      (entry) => root !== null && trimSlashes(entry.ticket.worktreePath ?? "") === root,
    ) ??
    tickets.find((entry) => entry.ticket.pr != null) ??
    tickets[0];
  if (view === undefined) return <EmptyFiles>This board has no tickets yet.</EmptyFiles>;
  return (
    <>
      <div className="relative flex h-8 shrink-0 items-center gap-1.5 px-3 text-[12px]">
        <GitBranch className="size-3.5 shrink-0 text-fg" aria-hidden />
        <span data-testid="checks-ticket" className="min-w-0 truncate font-semibold text-fg">
          {view.ticket.key} {view.ticket.title}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted" aria-hidden />
        {/* The picker is the whole row, drawn over it, so the ticket reads as Orca's workspace title. */}
        <select
          aria-label="Ticket"
          value={view.ticket.key}
          onChange={(event) => registry.set(checksTicketAtom, event.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
        >
          {tickets.map((entry) => (
            <option key={entry.ticket.key} value={entry.ticket.key} className="bg-panel">
              {entry.ticket.key} {entry.ticket.title}
            </option>
          ))}
        </select>
      </div>
      <TicketChecks key={view.ticket.key} view={view} active={open && tab === "checks"} />
    </>
  );
}
