import type * as React from "react";

import {
  formatSidebarPullRequestBadgeLabel,
  referencedPrPillClassName,
  type SidebarReferencedPullRequestState,
} from "../Sidebar.logic";

export interface SidebarPullRequestPillItem {
  url: string;
  number: string;
  state: SidebarReferencedPullRequestState;
}

export function SidebarPullRequestPills(props: {
  references: readonly SidebarPullRequestPillItem[];
  onOpenPullRequest: (event: React.MouseEvent<HTMLButtonElement>, prUrl: string) => void;
}) {
  if (props.references.length === 0) {
    return null;
  }

  return (
    <div className="flex min-w-0 w-full items-center gap-1 overflow-hidden pl-[3px] whitespace-nowrap">
      {props.references.map((reference) => {
        const stateLabel = reference.state ? ` (${reference.state})` : "";
        return (
          <button
            key={reference.url}
            type="button"
            data-testid={`sidebar-pr-pill-${reference.number}`}
            aria-label={`Open pull request ${formatSidebarPullRequestBadgeLabel(reference)}${stateLabel}`}
            className={`inline-flex max-w-full shrink-0 items-center rounded-sm border px-1.5 py-0 text-[10px] leading-4 transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring ${referencedPrPillClassName(reference.state)}`}
            onClick={(event) => {
              props.onOpenPullRequest(event, reference.url);
            }}
            title={reference.state ? `#${reference.number} PR ${reference.state}` : reference.url}
          >
            <span className="truncate">{formatSidebarPullRequestBadgeLabel(reference)}</span>
          </button>
        );
      })}
    </div>
  );
}
