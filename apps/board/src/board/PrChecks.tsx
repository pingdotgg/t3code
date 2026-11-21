import { CheckRows } from "../checks/CheckRows";
import { summarizeChecks } from "../checks/checkList";
import type { TicketView } from "../state/boardModel";
import { useTicketPr } from "../state/prStatus";

/** Each check on the ticket's pull request, in the rows the Checks tab uses. */
export function PrChecks({ view }: { view: TicketView }) {
  const { live, now } = useTicketPr(view);
  if (live === null) return null;
  return (
    <div className="border-b border-line px-3 py-2 text-[12px]">
      <p className="text-[10px] text-faint uppercase">Checks · {summarizeChecks(live.checks)}</p>
      {live.checks.length === 0 ? (
        <p data-testid="pr-no-checks" className="text-muted">
          No checks reported
        </p>
      ) : (
        <CheckRows checks={live.checks} now={now} />
      )}
    </div>
  );
}
