import { RegistryContext } from "@effect/atom-react";
import { GitCompareArrows } from "lucide-react";
import { useContext } from "react";

import type { Ticket } from "../domain/ticket";
import { openTicketChanges } from "../state/changesView";
import { Tooltip } from "../ui/Tooltip";

/** Opens a ticket's branch diff in the main view and its worktree in the Source Control tab. Draws nothing for a ticket with no worktree. */
export function ReviewChanges({ ticket, className }: { ticket: Ticket; className: string }) {
  const registry = useContext(RegistryContext);
  if (ticket.worktreePath == null) return null;
  return (
    <Tooltip text="Review changes" side="bottom" align="end">
      <button
        type="button"
        data-testid="review-changes"
        aria-label={`Review ${ticket.key} changes`}
        // A press here is a click, not the start of a ticket drag or a pan.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => openTicketChanges(registry, ticket)}
        className={className}
      >
        <GitCompareArrows className="size-3" aria-hidden />
      </button>
    </Tooltip>
  );
}
