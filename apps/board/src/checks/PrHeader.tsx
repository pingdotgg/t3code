import type { PullRequestDetail, PullRequestRef } from "@t3tools/contracts";
import { GitCompareArrows, MoreHorizontal, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { openInBrowser } from "../browser/browserTabs";
import { PopMenu } from "../ui/PopMenu";
import { Tooltip } from "../ui/Tooltip";

const ICON =
  "grid size-6 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg";

const UPDATED = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" });

const BADGE_TONE = {
  open: "border-emerald-500/20 bg-emerald-500/15 text-emerald-500",
  draft: "border-line bg-message text-muted",
  merged: "border-purple-500/20 bg-purple-500/15 text-purple-400",
  closed: "border-rose-500/20 bg-rose-500/10 text-rose-400",
} as const;

/** The pull request's number, state, title, update time, and the actions passed as children, laid out as the top of Orca's checks view. */
export function PrHeader({
  reference,
  detail,
  refreshing,
  onRefresh,
  children,
}: {
  reference: PullRequestRef;
  detail: PullRequestDetail | null;
  refreshing: boolean;
  onRefresh: () => void;
  children?: ReactNode;
}) {
  const badge =
    detail === null ? null : detail.state === "open" && detail.isDraft ? "draft" : detail.state;
  return (
    <header
      data-testid="pr-header"
      className="flex flex-col gap-2.5 border-b border-line px-3 py-3"
    >
      <div className="flex items-center gap-2">
        <GitCompareArrows className="size-4 shrink-0 text-muted" aria-hidden />
        <Tooltip text="Open on GitHub" side="bottom">
          <button
            type="button"
            disabled={detail === null}
            onClick={() => detail !== null && openInBrowser(detail.url)}
            className="rounded px-0.5 text-[12px] font-semibold text-fg underline decoration-line underline-offset-2 hover:decoration-fg focus-visible:ring-1 focus-visible:ring-line focus-visible:outline-none"
          >
            #{reference.number}
          </button>
        </Tooltip>
        {badge !== null && (
          <span
            data-testid="pr-badge"
            className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold tracking-wider uppercase ${BADGE_TONE[badge]}`}
          >
            {badge}
          </span>
        )}
        <span className="flex-1" />
        <Tooltip text="Refresh pull request" side="bottom" align="end">
          <button
            type="button"
            aria-label="Refresh pull request"
            onClick={onRefresh}
            disabled={refreshing}
            className={ICON}
          >
            <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden />
          </button>
        </Tooltip>
        <PopMenu
          label="Pull request menu"
          trigger={<MoreHorizontal className="size-3.5" aria-hidden />}
          triggerClass={ICON}
          items={[
            {
              label: "Open pull request",
              disabled: detail === null,
              onSelect: () => detail !== null && openInBrowser(detail.url),
            },
            {
              label: "Copy link",
              disabled: detail === null,
              onSelect: () => detail !== null && void navigator.clipboard.writeText(detail.url),
            },
          ]}
        />
      </div>
      {detail !== null && (
        <>
          <h2 data-testid="pr-title" className="text-[12px] leading-snug break-words text-fg">
            {detail.title}
          </h2>
          <p data-testid="pr-updated" className="text-[10px] text-muted/60">
            PR updated {UPDATED.format(new Date(detail.updatedAt))}
          </p>
        </>
      )}
      {children}
    </header>
  );
}
