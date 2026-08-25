/**
 * One report in the inbox, read as a sentence rather than a table row: the
 * title, then its lede continuing on the same line in muted text. No rules
 * between rows — whitespace and hover carry the separation, so a long list
 * reads as prose instead of a spreadsheet.
 *
 * The title is the thing being ruled on, so it takes the width it needs and
 * the lede yields. Time and actions sit in their own slots: hover must not
 * take away the staleness you are deciding on.
 */
import type { PostHogReport } from "@t3tools/contracts";
import { ArchiveRestoreIcon, ArchiveXIcon, MessagesSquareIcon } from "lucide-react";

import { statusColorVar } from "../../brand/statusColors";
import type { ReportWork } from "./inboxSections.logic";
import { cn } from "../../lib/utils";
import { PriorityChip } from "../reports/PriorityChip";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  humanizeReportTitle,
  rowTimeLabel,
  sourceProductLabel,
  summaryLine,
} from "./inboxList.logic";

export function ReportRow({
  report,
  work,
  showsRouting,
  unread,
  focused,
  busy,
  closed,
  onOpen,
  onArchive,
  onRestore,
  onFocus,
}: {
  readonly report: PostHogReport;
  /** What this machine is doing about the report, if anything. */
  readonly work: ReportWork;
  /**
   * Whether to mark reports PostHog routed to the reader. Only tells them
   * anything where the list also holds reports that were not.
   */
  readonly showsRouting: boolean;
  readonly unread: boolean;
  readonly focused: boolean;
  readonly busy: boolean;
  /** Archived and resolved reports offer restore where the others offer archive. */
  readonly closed: boolean;
  readonly onOpen: () => void;
  readonly onArchive: () => void;
  readonly onRestore: () => void;
  /**
   * Move the keyboard cursor here. Wired to real focus rather than hover:
   * the cursor decides what `e` archives, and a mouse resting on a row the
   * reader never chose must not become the target of a destructive key.
   */
  readonly onFocus: () => void;
}) {
  const lede = summaryLine(report.summary);
  const title = humanizeReportTitle(report.title);
  const source = report.source_products[0];

  return (
    <div
      data-report-row={report.id}
      data-focused={focused ? "" : undefined}
      onFocus={onFocus}
      className={cn(
        "group/row relative flex items-baseline gap-3 rounded-[var(--control-radius)] py-1.5 pe-2 ps-3 text-sm",
        focused ? "bg-accent/50" : "hover:bg-accent/25",
      )}
    >
      {/* The cursor bar sits in the row's own padding so nothing reflows when
          selection moves. Neutral, not tangerine: where you are standing is
          not something asking for you. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0.5 start-0 w-0.5 rounded-full",
          focused ? "bg-foreground/30" : "bg-transparent",
        )}
      />
      <span
        aria-hidden
        className="size-1.5 shrink-0 translate-y-[-1px] rounded-full"
        style={unread ? { backgroundColor: statusColorVar("needsYou") } : undefined}
      />
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-baseline gap-2 rounded-[var(--control-radius)] text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          className={cn(
            "max-w-full shrink-0 truncate sm:max-w-[72%]",
            unread ? "font-semibold text-foreground" : "text-foreground/80",
          )}
        >
          {title}
        </span>
        {lede ? (
          <span className="hidden min-w-0 flex-1 truncate text-muted-foreground sm:inline">
            {lede}
          </span>
        ) : null}
      </button>

      <div className="flex shrink-0 items-baseline gap-2 text-xs text-muted-foreground">
        {/* Local state first: what this machine is doing outranks anything
            PostHog recorded, because it is the part only you can see. */}
        {work.isRunning ? (
          <span className="flex items-center gap-1 text-foreground/70">
            <span aria-hidden className="size-1.5 rounded-full bg-sky-500" />
            Running
          </span>
        ) : work.hasThread ? (
          <MessagesSquareIcon className="size-3 self-center" aria-label="You have a conversation" />
        ) : null}
        {showsRouting && report.is_suggested_reviewer === true ? (
          <Tooltip>
            <TooltipTrigger render={<span className="cursor-help text-muted-foreground/70" />}>
              @you
            </TooltipTrigger>
            <TooltipPopup side="top">PostHog named you a reviewer</TooltipPopup>
          </Tooltip>
        ) : null}
        {report.priority ? (
          <PriorityChip priority={report.priority} className="translate-y-px" />
        ) : null}
        {source ? (
          <span className="hidden truncate sm:inline">{sourceProductLabel(source)}</span>
        ) : null}
        {/* Fixed width so the column never jitters as relative labels change. */}
        <span className="w-10 shrink-0 text-end tabular-nums">
          {rowTimeLabel(report.updated_at)}
        </span>
        {/* Its own reserved slot rather than the timestamp's: deciding whether
            to archive is exactly when you want to know how old this is. */}
        <span className="flex w-5 shrink-0 justify-end self-center opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
          <Button
            size="icon-micro"
            variant="ghost"
            disabled={busy}
            aria-label={closed ? `Restore ${title}` : `Archive ${title}`}
            onClick={closed ? onRestore : onArchive}
          >
            {closed ? (
              <ArchiveRestoreIcon className="size-3.5" />
            ) : (
              <ArchiveXIcon className="size-3.5" />
            )}
          </Button>
        </span>
      </div>
    </div>
  );
}
