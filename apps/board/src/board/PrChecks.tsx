import { isStuck } from "../domain/readiness";
import type { TicketView } from "../state/boardModel";
import { useTicketPr } from "../state/prStatus";

const RESULT = {
  success: { label: "Passed", tone: "text-emerald-300" },
  failure: { label: "Failed", tone: "text-red-300" },
  pending: { label: "Running", tone: "text-amber-300" },
  "action-required": { label: "Needs approval", tone: "text-amber-300" },
  skipped: { label: "Skipped", tone: "text-faint" },
  neutral: { label: "Neutral", tone: "text-muted" },
  cancelled: { label: "Cancelled", tone: "text-red-300" },
} as const;

/** Each check on the ticket's pull request and how it ended. */
export function PrChecks({ view }: { view: TicketView }) {
  const { live, now } = useTicketPr(view);
  if (live === null) return null;
  return (
    <div className="border-b border-line px-3 py-2 text-[12px]">
      <p className="text-[10px] text-faint uppercase">Checks</p>
      {live.checks.length === 0 ? (
        <p data-testid="pr-no-checks" className="text-muted">
          No checks reported
        </p>
      ) : (
        <ul aria-label="Checks" className="flex flex-col gap-0.5">
          {live.checks.map((check) => {
            const stuck = isStuck(check, now);
            const result = stuck ? { label: "Stuck", tone: "text-red-300" } : RESULT[check.status];
            return (
              <li
                key={check.name}
                data-testid="pr-check"
                data-status={stuck ? "stuck" : check.status}
                className="flex items-baseline gap-2"
              >
                <span className="min-w-0 flex-1 truncate text-fg">{check.name}</span>
                <span className={`shrink-0 ${result.tone}`}>{result.label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
