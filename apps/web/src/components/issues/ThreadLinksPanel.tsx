import type { ScopedThreadRef } from "@t3tools/contracts";

import { ThreadPullRequestsPanel } from "../pullRequest/ThreadPullRequestsPanel";
import { ThreadIssueLinks } from "./ThreadIssueLinks";

/**
 * The thread's right-panel links: Issues above pull requests. Issues show only where the server
 * advertises `issueLinks`; elsewhere this is the pull request panel alone.
 */
export function ThreadLinksPanel({
  threadRef,
  issueLinks,
}: {
  threadRef: ScopedThreadRef;
  issueLinks: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {issueLinks ? <ThreadIssueLinks threadRef={threadRef} /> : null}
      <div className="min-h-0 flex-1">
        <ThreadPullRequestsPanel threadRef={threadRef} />
      </div>
    </div>
  );
}
