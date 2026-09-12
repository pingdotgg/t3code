import type { PullRequestContextMetadata } from "@t3tools/contracts";
import { ArrowRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { resolvePullRequestState } from "./pullRequest/pullRequestPresentation";

export function PullRequestContextDetails({ metadata }: { metadata: PullRequestContextMetadata }) {
  const state = resolvePullRequestState(metadata);
  return (
    <div className="max-w-80 space-y-1 overflow-hidden py-0.5 text-left">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <state.Icon className={cn("size-3.5 shrink-0", state.toneClassName)} />
        <span className="text-foreground">Pull request #{metadata.number}</span>
        <span className={state.toneClassName}>{state.label}</span>
      </div>
      <div className="wrap-break-word text-foreground">{metadata.title}</div>
      <div className="flex min-w-0 items-center gap-1 text-secondary-label text-[10px]">
        <code className="truncate">{metadata.headBranch}</code>
        <ArrowRightIcon className="size-3 shrink-0" aria-hidden="true" />
        <code className="truncate">{metadata.baseBranch}</code>
      </div>
    </div>
  );
}
