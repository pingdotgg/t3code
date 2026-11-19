import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import type { PullRequestStack } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { changeRequestTermKind } from "./changeRequestTerm";
import { resolvePullRequestState } from "./pullRequestPresentation";

/**
 * Stack navigation puts the title over its number and branch; confirmations use a compact row.
 */
export function PullRequestStackLayerContent({
  layer,
  terminology,
  compact = false,
  position,

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
  const gt = useGT();
  const messages = useMessages();
  const state = resolvePullRequestState(
    {
      state: layer.state,
      isDraft: layer.isDraft ?? false,
    },
    messages,
  );
  if (compact) {
    return (
      <>
        <state.Icon
          aria-label={state.label}
          className={cn("size-4 shrink-0", state.toneClassName)}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{layer.title || layer.headBranch}</span>
          <span className="block text-meta text-muted-foreground">#{layer.number}</span>
        </span>
      </>
    );
  }

  const badge = current ? (
    <Badge variant="success">
      {gt("This {term, select, mr {MR} cr {change request} other {PR}}", {
        term: changeRequestTermKind(terminology),
      })}
    </Badge>
  ) : layer.state === "merged" ? (
    <Badge variant="merged">{gt("Merged", { $context: "pull request state" })}</Badge>
  ) : layer.state === "closed" ? (
    <Badge variant="secondary">{gt("Closed", { $context: "pull request state" })}</Badge>
  ) : layer.isDraft ? (
    <Badge variant="secondary">{gt("Draft", { $context: "pull request state" })}</Badge>
  ) : null;
  return (
    <>
      <span className="flex w-4 shrink-0 flex-col items-center gap-1 self-stretch pt-2">
        <state.Icon
          aria-label={state.label}
          className={cn("size-4 shrink-0", state.toneClassName)}
        />
        {position !== undefined ? <span className="w-px flex-1 bg-border" /> : null}
      </span>
      <span className="min-w-0 flex-1 py-2">
        <span className="block truncate text-label">{layer.title || layer.headBranch}</span>
        <span className="mt-0.5 flex min-w-0 gap-1.5 font-mono text-meta text-muted-foreground">
          <span>#{layer.number}</span>
          <span className="truncate">{layer.headBranch}</span>
        </span>
      </span>
      {badge}
    </>
  );
}
