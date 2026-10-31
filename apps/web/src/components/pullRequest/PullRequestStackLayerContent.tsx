import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestStack } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { resolvePullRequestState } from "./pullRequestPresentation";

/**
 * One layer of a stack. In the stack menu it reads "#num Title" over where the layer sits, with a
 * badge for the layers worth calling out; the confirm dialogs use the compact "#num · state" line.
 */
export function PullRequestStackLayerContent({
  layer,
  terminology,
  compact = false,
  position,
  size,
  base,
  current = false,
}: {
  layer: PullRequestStack["layers"][number];
  terminology: ChangeRequestTerminology;
  compact?: boolean;
  /** 1-based, bottom of the stack first. */
  position?: number;
  size?: number;
  base?: string;
  current?: boolean;
}) {
  const state = resolvePullRequestState({
    state: layer.state,
    isDraft: layer.isDraft ?? false,
  });
  if (compact) {
    return (
      <>
        <state.Icon aria-hidden className={cn("size-4 shrink-0", state.toneClassName)} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{layer.title || layer.headBranch}</span>
          <span className="block truncate text-meta text-muted-foreground">
            #{layer.number} · {state.label}
          </span>
        </span>
      </>
    );
  }
  const subline =
    position === 1 && base
      ? `base: ${base}`
      : position !== undefined && size !== undefined
        ? `layer ${position} of ${size}`
        : layer.headBranch;
  const badge = current ? (
    <Badge variant="info">This {terminology.shortLabel}</Badge>
  ) : layer.state === "merged" ? (
    <Badge variant="secondary">Merged</Badge>
  ) : layer.state === "closed" ? (
    <Badge variant="secondary">Closed</Badge>
  ) : layer.isDraft ? (
    <Badge variant="secondary">Draft</Badge>
  ) : null;
  return (
    <>
      <state.Icon aria-hidden className={cn("size-4 shrink-0", state.toneClassName)} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 font-mono text-meta text-muted-foreground">
            #{layer.number}
          </span>
          <span className="truncate">{layer.title || layer.headBranch}</span>
        </span>
        <span className="block truncate text-meta text-muted-foreground">{subline}</span>
      </span>
      {badge}
    </>
  );
}
