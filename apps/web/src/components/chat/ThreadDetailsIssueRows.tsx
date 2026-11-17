import { threadIssueKeyOf, type ThreadIssueLink } from "@t3tools/contracts";
import type { MouseEvent as ReactMouseEvent } from "react";

import { cn } from "~/lib/utils";

import { IssueGlyph } from "../issue/issuePresentation";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

/**
 * The thread details panel's issue rows, one per linked issue, beside the pull request rows. A
 * row names the issue as it was when linked and opens it in the right panel, which reads its
 * live state.
 */
export function ThreadDetailsIssueRows({
  links,
  onOpenLink,
}: {
  links: ReadonlyArray<ThreadIssueLink>;
  onOpenLink: (event: ReactMouseEvent<HTMLElement>, link: ThreadIssueLink) => void;
}) {
  if (links.length === 0) return null;
  return (
    <>
      {links.map((link) => (
        <ThreadDetailsControl
          key={threadIssueKeyOf(link)}
          part="row"
          aria-label={link.url}
          onClick={(event) => onOpenLink(event, link)}
        >
          <IssueGlyph.issue aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
            {link.displayKey}: {link.title}
          </span>
        </ThreadDetailsControl>
      ))}
    </>
  );
}
