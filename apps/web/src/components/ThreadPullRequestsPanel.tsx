import type {
  GitPullRequestAssociation,
  ThreadPullRequestLink,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { GitPullRequestIcon } from "lucide-react";

import { openPullRequestLink } from "../lib/openPullRequestLink";
import { cn } from "../lib/utils";
import { prStatusIndicator } from "./ThreadStatusIndicators";
import { resolveThreadPullRequests } from "./ThreadPullRequestsPopover";

export function ThreadPullRequestsPanel({
  threadRef,
  links,
  fallbackPullRequest,
  visible,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly links: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly fallbackPullRequest: GitPullRequestAssociation | null | undefined;
  readonly visible: boolean;
}) {
  const pullRequests = resolveThreadPullRequests(links, fallbackPullRequest);

  return (
    <section
      aria-label="Linked pull requests"
      className={cn("flex min-h-0 flex-1 flex-col bg-chat-background", !visible && "hidden")}
      data-thread-pull-requests-panel
    >
      <div className="border-b border-border/70 px-3 py-2">
        <h2 className="text-xs font-medium text-foreground">Linked pull requests</h2>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Pull requests associated with this conversation.
        </p>
      </div>
      {pullRequests.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <div className="grid gap-1">
            {pullRequests.map((pullRequest) => {
              const status = prStatusIndicator(pullRequest);
              return (
                <a
                  key={`${pullRequest.url}-${pullRequest.number}`}
                  href={pullRequest.url}
                  className="flex min-w-0 items-start gap-2 rounded-md px-2.5 py-2 text-xs hover:bg-muted focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={(event) => {
                    if (
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    ) {
                      return;
                    }
                    openPullRequestLink(event, pullRequest.url, threadRef);
                  }}
                >
                  <GitPullRequestIcon
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      status?.colorClass ?? "text-sky-600 dark:text-sky-300/90",
                    )}
                  />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="shrink-0 font-mono tabular-nums text-foreground">
                        #{pullRequest.number}
                      </span>
                      <span className="truncate text-muted-foreground">
                        {pullRequest.title || "Pull request"}
                      </span>
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground/80">
                      {pullRequest.baseBranch && pullRequest.headBranch
                        ? `${pullRequest.headBranch} → ${pullRequest.baseBranch}`
                        : pullRequest.url}
                    </span>
                  </span>
                </a>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
          No pull requests are linked to this conversation.
        </div>
      )}
    </section>
  );
}
