import type {
  PullRequestActor,
  PullRequestMergeability,
  PullRequestState,
} from "@t3tools/contracts";
import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";

export function pullRequestStatePresentation(input: {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability?: PullRequestMergeability;
}) {
  if (input.state === "merged") {
    return { label: "Merged", Icon: GitMergeIcon, className: "text-violet-500" };
  }
  if (input.state === "closed") {
    return { label: "Closed", Icon: GitPullRequestClosedIcon, className: "text-red-500" };
  }
  if (input.isDraft) {
    return { label: "Draft", Icon: GitPullRequestDraftIcon, className: "text-muted-foreground" };
  }
  if (input.mergeability === "conflicting") {
    return { label: "Conflicting", Icon: TriangleAlertIcon, className: "text-destructive" };
  }
  return { label: "Open", Icon: GitPullRequestIcon, className: "text-emerald-500" };
}

export function PullRequestStateGlyph({
  state,
  isDraft,
  mergeability,
}: {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability?: PullRequestMergeability;
}) {
  const presentation = pullRequestStatePresentation({
    state,
    isDraft,
    ...(mergeability ? { mergeability } : {}),
  });
  return (
    <presentation.Icon
      aria-label={presentation.label}
      className={cn("size-4 shrink-0", presentation.className)}
    />
  );
}

export function PullRequestActorLabel({
  actor,
  className,
}: {
  readonly actor: PullRequestActor | null;
  readonly className?: string;
}) {
  const login = actor?.login ?? "ghost";
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)} title={login}>
      {actor?.avatarUrl ? (
        <img alt="" className="size-4 rounded-full" loading="lazy" src={actor.avatarUrl} />
      ) : (
        <span className="flex size-4 items-center justify-center rounded-full bg-muted text-[9px]">
          {login.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="truncate">{login}</span>
    </span>
  );
}

export function PullRequestDiffStat({
  additions,
  deletions,
}: {
  readonly additions: number;
  readonly deletions: number;
}) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span className="inline-flex gap-1 tabular-nums text-xs">
      <span className="text-emerald-600 dark:text-emerald-300">+{additions}</span>
      <span className="text-destructive">-{deletions}</span>
    </span>
  );
}
