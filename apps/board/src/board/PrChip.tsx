import { Check, CircleDashed, TriangleAlert, X } from "lucide-react";
import { useCallback, useRef } from "react";

import { openInBrowser } from "../browser/browserTabs";
import { isStuck, type PrLive, rollupChecks } from "../domain/readiness";
import type { TicketView } from "../state/boardModel";
import { useTicketPr } from "../state/prStatus";

const STATE = {
  open: { label: "Open", tone: "text-emerald-300" },
  merged: { label: "Merged", tone: "text-violet-300" },
  closed: { label: "Closed", tone: "text-red-300" },
} as const satisfies Record<PrLive["state"], { label: string; tone: string }>;

const CHECKS = {
  passing: { label: "Passing", tone: "text-emerald-300", Icon: Check },
  failing: { label: "Failing", tone: "text-red-300", Icon: X },
  pending: { label: "Running", tone: "text-amber-300", Icon: CircleDashed },
  stuck: { label: "Stuck", tone: "text-red-300", Icon: TriangleAlert },
  none: { label: "No checks", tone: "text-faint", Icon: CircleDashed },
} as const;

const prText = (pr: NonNullable<TicketView["ticket"]["pr"]>) => {
  const text = String(pr);
  return /^\d+$/.test(text) ? `#${text}` : (text.split("/").at(-1) ?? text);
};

/** How the checks read now. A check running past the limit reads as stuck, whatever the host rolled up. */
export function checksReading(live: PrLive, now: number): keyof typeof CHECKS {
  if (live.checks.some((check) => isStuck(check, now))) return "stuck";
  return live.checksState ?? rollupChecks(live.checks) ?? "none";
}

/** A ticket's pull request on its frame: its number, state, checks, and whether it merges cleanly. */
export function PrChip({ view }: { view: TicketView }) {
  const { ref, live, now } = useTicketPr(view);
  const shown = useRef<string | null>(null);
  const { pr } = view.ticket;
  const label = ref !== null ? `#${ref.number}` : pr == null ? null : prText(pr);
  const reading = live === null ? null : checksReading(live, now);
  const text = live === null ? "loading" : `${live.state}/${reading}/${live.mergeability}`;

  // A ref callback runs after the commit that shows a new reading, which is what the user waits on.
  const mark = useCallback(
    (element: HTMLElement | null) => {
      const before = shown.current;
      if (element === null || before === text) return;
      shown.current = text;
      if (before !== null) {
        requestAnimationFrame(() =>
          performance.mark("board:pr-painted", { detail: { label, reading: text } }),
        );
      }
    },
    [text, label],
  );

  if (label === null) {
    return <span className="text-[11px] text-faint">No pull request yet</span>;
  }
  if (live === null || reading === null) {
    return (
      <span
        ref={mark}
        data-testid="pr-chip"
        data-state="loading"
        className="inline-flex items-center gap-1 rounded border border-line px-1.5 text-[10px] leading-4 text-muted"
      >
        PR {label}
        {ref === null ? " not found" : " loading"}
      </span>
    );
  }
  const state = STATE[live.state];
  const checks = CHECKS[reading];
  const settled = live.state !== "open";
  return (
    <a
      href={live.url ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      ref={mark}
      data-testid="pr-chip"
      data-state={live.state}
      data-checks={reading}
      data-mergeability={live.mergeability}
      aria-label={`Pull request ${label}, ${state.label.toLowerCase()}${settled ? "" : `, checks ${checks.label.toLowerCase()}, ${live.mergeability}`}`}
      className={`inline-flex min-w-0 items-center gap-1.5 rounded border border-line px-1.5 text-[10px] leading-4 text-muted ${live.url === null ? "" : "hover:border-focus"}`}
      // A press on the chip is a click, not the start of a ticket drag.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        if (live.url === null) return;
        event.preventDefault();
        openInBrowser(live.url);
      }}
    >
      <span className="text-fg">PR {label}</span>
      <span className={state.tone}>{state.label}</span>
      {!settled && (
        <>
          <span className={`inline-flex items-center gap-0.5 ${checks.tone}`}>
            <checks.Icon className="size-3" aria-hidden />
            {checks.label}
          </span>
          {live.mergeability !== "unknown" && (
            <span className={live.mergeability === "conflicting" ? "text-red-300" : undefined}>
              {live.mergeability === "mergeable" ? "Mergeable" : "Conflicts"}
            </span>
          )}
        </>
      )}
    </a>
  );
}
