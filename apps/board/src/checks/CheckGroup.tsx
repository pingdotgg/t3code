import {
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  LoaderCircle,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import type { PrLive } from "../domain/readiness";
import { CheckRows } from "./CheckRows";
import { type RollupPart, rollupParts, summarizeChecks } from "./checkList";

const KIND = {
  failing: { Icon: CircleX, tone: "text-rose-500" },
  "needs action": { Icon: TriangleAlert, tone: "text-amber-500" },
  running: { Icon: LoaderCircle, tone: "text-amber-500" },
  passing: { Icon: CircleCheck, tone: "text-emerald-500" },
  skipped: { Icon: CircleMinus, tone: "text-muted/60" },
  neutral: { Icon: CircleDashed, tone: "text-muted" },
} satisfies Record<
  Exclude<RollupPart["label"], "some not listed">,
  { Icon: LucideIcon; tone: string }
>;

/** The checks as one group headed by a count per kind, open at first and collapsible, as Orca's list is. */
export function CheckGroup({ live, now }: { live: PrLive; now: number }) {
  const [open, setOpen] = useState(true);
  return (
    <section aria-label="Checks" data-testid="check-group" className="flex min-h-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Checks, ${summarizeChecks(live.checks)}`}
        onClick={() => setOpen(!open)}
        className="flex w-full shrink-0 items-center gap-3 border-b border-line px-3 py-2 text-left text-[10px] text-muted transition-colors hover:bg-hover/60 hover:text-fg"
      >
        <ChevronDown
          className={`size-3 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
          aria-hidden
        />
        <span data-testid="check-rollup" className="flex min-w-0 flex-wrap items-center gap-x-3">
          {rollupParts(live.checks).map((part) => {
            const kind = part.label === "some not listed" ? null : KIND[part.label];
            return (
              <span key={part.label} className="flex items-center gap-1">
                {kind !== null && <kind.Icon className={`size-3 ${kind.tone}`} aria-hidden />}
                {part.label === "some not listed" ? part.label : `${part.count} ${part.label}`}
              </span>
            );
          })}
          {live.checks.length === 0 && "No checks"}
        </span>
      </button>
      {open && live.checks.length > 0 && (
        <div className="max-h-64 min-h-0 overflow-y-auto py-1">
          <CheckRows checks={live.checks} now={now} />
        </div>
      )}
    </section>
  );
}
