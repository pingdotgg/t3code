import type { IssueListEntry } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { PullRequestDetailTitleRow } from "../pullRequest/PullRequestDetailLayout";
import { GhostBar } from "../pullRequest/PullRequestGhosts";
import { PullRequestActorLabel } from "../pullRequest/pullRequestPresentation";
import { issueStatePresentation } from "./issuePresentation";

/**
 * The issue panel while its detail loads: the loaded header's own rows, filled with what the
 * list row already knows, over the description and comment cards' shapes.
 */
export function IssueDetailGhost({ seed }: { seed?: IssueListEntry | null }) {
  const gt = useGT();
  const messages = useMessages();
  const state = seed ? issueStatePresentation(seed.state) : null;
  return (
    <div
      role="status"
      aria-label={gt("Loading issue")}
      className={cn(
        "flex h-[calc(100%+var(--surface-top-inset,0px))] min-h-0 flex-col overflow-hidden bg-(--code-surface) pt-under-header",
        !seed && "motion-safe:animate-skeleton",
      )}
      data-surface-reaches-under-header=""
    >
      <div className="mt-2 flex min-h-6 min-w-0 items-center gap-1.5 pl-4 text-label text-muted-foreground">
        {seed && state ? (
          <>
            <span className="min-w-16 truncate">{seed.scope}</span>
            <span className={cn("shrink-0", state.toneClassName)}>{seed.displayKey}</span>
          </>
        ) : (
          <>
            <GhostBar className="w-28" />
            <GhostBar className="w-12" />
          </>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 px-4 pt-1.5 pb-2.5">
        {seed ? (
          <>
            <PullRequestDetailTitleRow>
              <h1 className="min-w-0 flex-1 text-title leading-(--pr-title-leading) [--pr-title-leading:1.3] wrap-anywhere text-foreground [--type-title:0.9375rem]">
                {seed.title}
              </h1>
            </PullRequestDetailTitleRow>
            <div className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground">
              <PullRequestActorLabel actor={seed.author} />
              <span className="shrink-0">
                <T>
                  opened <Var>{formatRelativeTimeLabel(seed.createdAt, undefined, messages)}</Var>
                </T>
              </span>
            </div>
          </>
        ) : (
          <>
            <PullRequestDetailTitleRow>
              <GhostBar className="h-4 w-3/4" />
            </PullRequestDetailTitleRow>
            <div className="flex min-h-5 items-center gap-1.5">
              <GhostBar className="size-4 rounded-full" />
              <GhostBar className="w-28" />
            </div>
          </>
        )}
      </div>
      <div className={cn("flex flex-col gap-3 px-4 pt-3", seed && "motion-safe:animate-skeleton")}>
        <GhostBar className="w-20" />
        <GhostBar className="h-3.5 w-full" />
        <GhostBar className="h-3.5 w-5/6" />
        <GhostBar className="h-3.5 w-2/3" />
        <GhostBar className="mt-4 w-16" />
        {[0, 1].map((row) => (
          <div key={row} className="flex flex-col gap-2 rounded-xl surface-panel px-3 py-2.5">
            <div className="flex items-center gap-1.5">
              <GhostBar className="size-4 rounded-full" />
              <GhostBar className="w-24" />
            </div>
            <GhostBar className="w-full" />
            <GhostBar className="w-3/4" />
          </div>
        ))}
      </div>
    </div>
  );
}
