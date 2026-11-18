import type { IssueListEntry } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { ExternalLinkIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Button } from "../ui/button";
import { PullRequestDetailTitleRow } from "../pullRequest/PullRequestDetailLayout";
import { GhostBar } from "../pullRequest/PullRequestGhosts";
import {
  PullRequestActorLabel,
  PullRequestLabelChip,
} from "../pullRequest/pullRequestPresentation";
import { IssueStateGlyph, issueTrackerPresentation } from "./issuePresentation";

/** The issue panel while its detail loads, showing what the list row already knows. */
export function IssueDetailGhost({ seed }: { seed?: IssueListEntry | null }) {
  const gt = useGT();
  const messages = useMessages();
  const tracker = seed ? issueTrackerPresentation(seed.tracker) : null;
  return (
    <div
      role="status"
      aria-label={gt("Loading issue")}
      className={cn(
        "scrollbar-gutter-both flex h-full min-h-0 flex-col gap-4 overflow-hidden px-4 pt-3 pb-4",
        !seed && "motion-safe:animate-skeleton",
      )}
    >
      {seed && tracker ? (
        <>
          <PullRequestDetailTitleRow className="gap-2">
            <IssueStateGlyph state={seed.state} />
            <span className="shrink-0 font-mono text-meta text-muted-foreground">
              {seed.displayKey}
            </span>
            <span className="min-w-0 flex-1 truncate text-meta text-muted-foreground">
              <tracker.Icon aria-hidden className="mr-1 inline size-3 align-[-2px]" />
              {seed.scope}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={gt("Open on {provider}", { provider: tracker.providerName })}
              render={<a href={seed.url} target="_blank" rel="noopener noreferrer" />}
            >
              <ExternalLinkIcon aria-hidden className="size-3.5" />
            </Button>
          </PullRequestDetailTitleRow>
          {/* Leaves room for the edit button, so the title wraps the same once loaded. */}
          <h2 className="pr-7 text-title leading-(--pr-title-leading) [--pr-title-leading:1.3] [--type-title:1rem]">
            {seed.title}
          </h2>
          <span className="flex min-w-0 items-center gap-x-2.5 text-meta text-muted-foreground">
            <PullRequestActorLabel actor={seed.author} />
            <span>
              <T>
                opened <Var>{formatRelativeTimeLabel(seed.createdAt, undefined, messages)}</Var>
              </T>
            </span>
            {seed.closedAt ? (
              <span>
                <T>
                  closed <Var>{formatRelativeTimeLabel(seed.closedAt, undefined, messages)}</Var>
                </T>
              </span>
            ) : null}
          </span>
          {/* Both rows hold the height of the picker button the loaded panel puts in them. */}
          <div className="flex min-h-6 flex-wrap items-center gap-1.5 text-meta text-muted-foreground">
            <span className="shrink-0">
              <T>Labels</T>
            </span>
            {seed.labels.length === 0 ? (
              <span>
                <T context="no labels">none</T>
              </span>
            ) : null}
            {seed.labels.map((label) => (
              <PullRequestLabelChip key={label.name} label={label} />
            ))}
          </div>
          <div className="flex min-h-6 flex-wrap items-center gap-1.5 text-meta text-muted-foreground">
            <span className="shrink-0">
              <T>Assignees</T>
            </span>
            {seed.assignees.length === 0 ? (
              <span>
                <T context="no assignees">none</T>
              </span>
            ) : null}
            {seed.assignees.map((actor) => (
              <PullRequestActorLabel key={actor.login} actor={actor} />
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="flex h-7 items-center gap-2">
            <GhostBar className="size-4 rounded-full" />
            <GhostBar className="w-12" />
            <GhostBar className="w-32" />
          </div>
          <GhostBar className="h-5 w-3/4" />
          <GhostBar className="w-48" />
          <GhostBar className="w-32" />
        </>
      )}
      <div className={cn("flex flex-col gap-4", seed && "motion-safe:animate-skeleton")}>
        <div className="flex flex-col gap-2.5 rounded-lg border border-border/60 p-3">
          <GhostBar className="w-20" />
          <GhostBar className="h-3.5 w-full" />
          <GhostBar className="h-3.5 w-5/6" />
          <GhostBar className="h-3.5 w-2/3" />
          <GhostBar className="h-3.5 w-3/4" />
        </div>
        <GhostBar className="w-16" />
        {[0, 1].map((row) => (
          <div key={row} className="flex items-start gap-2">
            <GhostBar className="size-5 shrink-0 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <GhostBar className="w-1/3" />
              <GhostBar className="w-full" />
              <GhostBar className="w-3/4" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
