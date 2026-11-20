import {
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleX,
  ExternalLink,
  LoaderCircle,
  type LucideIcon,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";

import { formatElapsed } from "../chat/MessageActions";
import { openInBrowser } from "../browser/browserTabs";
import { type CheckRun, type CheckStatus, isStuck } from "../domain/readiness";
import { Tooltip } from "../ui/Tooltip";
import { durationOf } from "./checkList";

const STATUS = {
  pending: { label: "Running", tone: "text-amber-500", Icon: LoaderCircle },
  "action-required": { label: "Needs approval", tone: "text-amber-500", Icon: TriangleAlert },
  success: { label: "Passed", tone: "text-emerald-500", Icon: CircleCheck },
  failure: { label: "Failed", tone: "text-rose-500", Icon: CircleX },
  cancelled: { label: "Cancelled", tone: "text-muted/60", Icon: CircleX },
  skipped: { label: "Skipped", tone: "text-muted/60", Icon: CircleMinus },
  neutral: { label: "Neutral", tone: "text-muted", Icon: CircleDashed },
} satisfies Record<CheckStatus, { label: string; tone: string; Icon: LucideIcon }>;

/**
 * One check as Orca's checks list draws it: a chevron, its status icon, its name, the time, and the
 * link out. The host reports no start time, so the time column holds only what the description
 * says or how long the board has watched a running check. Opening the row shows the description
 * and the link, where Orca shows the run's output.
 */
export function CheckRow({ check, now }: { check: CheckRun; now: number }) {
  const [open, setOpen] = useState(false);
  if (check.placeholder) {
    return (
      <li
        data-testid="pr-check"
        data-status="placeholder"
        className="px-3 py-1.5 text-[12px] text-muted"
      >
        {check.name}
      </li>
    );
  }
  const stuck = isStuck(check, now);
  const { label, tone, Icon } = stuck
    ? { label: "Stuck", tone: "text-rose-500", Icon: STATUS.pending.Icon }
    : STATUS[check.status];
  const duration = durationOf(check.description);
  const running =
    check.runningSince === null
      ? null
      : `Running for ${formatElapsed(Math.max(0, Math.floor((now - check.runningSince) / 1_000)))}`;
  const time = running ?? duration;
  const timeTone = stuck ? "text-rose-500" : "text-muted";
  return (
    <li
      data-testid="pr-check"
      data-status={stuck ? "stuck" : check.status}
      data-required={check.required}
      className="@container min-w-0"
    >
      <div
        className={`flex min-w-0 items-center gap-2 pr-2 transition-colors hover:bg-hover/60 ${open ? "bg-hover/40" : ""}`}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${check.name}, ${label.toLowerCase()}`}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pl-3 text-left text-[12px]"
        >
          <ChevronRight
            className={`size-3 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden
          />
          <Icon
            className={`size-3.5 shrink-0 ${tone} ${check.status === "pending" && !stuck ? "animate-spin" : ""}`}
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-fg">{check.name}</span>
              {check.required && (
                <span
                  data-testid="pr-check-required"
                  className="shrink-0 rounded border border-line bg-message px-1 text-[9px] leading-4 font-semibold tracking-wider text-muted uppercase"
                >
                  Required
                </span>
              )}
            </span>
            {check.description !== null && check.description !== "" && (
              <span className="block truncate text-[11px] text-muted">{check.description}</span>
            )}
            {/* In a narrow container, such as a card, the time drops under the name instead of squeezing it. */}
            {time !== null && (
              <span className={`block text-[11px] tabular-nums @[19rem]:hidden ${timeTone}`}>
                {time}
              </span>
            )}
          </span>
          {time !== null && (
            <span
              data-testid="pr-check-time"
              className={`hidden shrink-0 text-[11px] tabular-nums @[19rem]:block ${timeTone}`}
            >
              {time}
            </span>
          )}
        </button>
        {check.url !== null && (
          <Tooltip text="Open check details" side="bottom" align="end">
            <button
              type="button"
              aria-label={`Open ${check.name}`}
              data-testid="pr-check-link"
              onClick={() => check.url !== null && openInBrowser(check.url)}
              className="grid size-6 shrink-0 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
            >
              <ExternalLink className="size-3" aria-hidden />
            </button>
          </Tooltip>
        )}
      </div>
      {open && (
        <div className="mr-3 mb-1 ml-[26px] flex min-w-0 flex-col gap-1 border-l border-line py-1.5 pl-3 text-[11px] text-muted">
          <p>
            Status: <span className={tone}>{label}</span>
            {check.required ? " · Required by branch protection" : ""}
          </p>
          <p data-testid="pr-check-description" className="break-words">
            {check.description === null || check.description === ""
              ? "The host gave no description."
              : check.description}
          </p>
          {check.url !== null && (
            <button
              type="button"
              onClick={() => check.url !== null && openInBrowser(check.url)}
              className="w-fit rounded border border-line px-2 py-0.5 text-fg hover:bg-hover"
            >
              View full details
            </button>
          )}
        </div>
      )}
    </li>
  );
}
