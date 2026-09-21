import type { PullRequestStack } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { resolvePullRequestState } from "./pullRequestPresentation";

export function PullRequestStackLayerContent({
  layer,
  compact = false,
}: {
  layer: PullRequestStack["layers"][number];
  compact?: boolean;
}) {
  const state = resolvePullRequestState({
    state: layer.state,
    isDraft: layer.isDraft ?? false,
  });
  return (
    <>
      <state.Icon aria-hidden className={cn("size-4 shrink-0", state.toneClassName)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{layer.title || layer.headBranch}</span>
        <span className="flex min-w-0 items-center gap-3 text-xs font-normal text-muted-foreground">
          <span className="shrink-0">#{layer.number}</span>
          {compact ? null : <span className="truncate">{layer.headBranch}</span>}
          <span className="shrink-0">{state.label}</span>
        </span>
      </span>
    </>
  );
}
