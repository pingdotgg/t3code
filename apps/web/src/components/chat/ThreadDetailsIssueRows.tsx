import { threadIssueKeyOf, type ScopedThreadRef } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadShell } from "../../state/entities";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { issueDisplayLabel } from "../issue/issueDetail.logic";
import { IssueGlyph, resolveIssueStatePresentation } from "../issue/issuePresentation";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

/**
 * The thread details panel's issue rows, one per linked issue, beside the pull request rows. A
 * row opens the issue in the right panel; the snapshot the server keeps on the link supplies the
 * key, title and state, so no tracker read happens on render. Until the first snapshot lands the
 * row shows what the link itself carries.
 */
export function ThreadDetailsIssueRows({ threadRef }: { threadRef: ScopedThreadRef }) {
  const links = useThreadShell(threadRef)?.issues ?? [];
  if (links.length === 0) return null;
  return (
    <>
      {links.map((link) => {
        const state =
          link.snapshot === null ? null : resolveIssueStatePresentation(link.snapshot.state);
        const label =
          link.snapshot === null
            ? issueDisplayLabel(link.scope, link.key)
            : `${link.snapshot.displayKey}: ${link.snapshot.title}`;
        return (
          <Tooltip key={threadIssueKeyOf(link)}>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  part="row"
                  aria-label={link.url}
                  onClick={(event) => {
                    event.stopPropagation();
                    useRightPanelStore.getState().openIssue(threadRef, link);
                  }}
                />
              }
            >
              {state === null ? (
                <IssueGlyph.issue aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              ) : (
                <state.Icon aria-hidden className={cn("size-4 shrink-0", state.toneClassName)} />
              )}
              <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
                {label}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="top">
              {state === null ? "Issue not read yet" : state.label}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </>
  );
}
