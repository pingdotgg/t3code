import type { PullRequestStack } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { useTranslation } from "@t3tools/i18n/react";
import { resolvePullRequestState } from "./pullRequestPresentation";

export function PullRequestStackLayerContent({
  layer,
  compact = false,
}: {
  layer: PullRequestStack["layers"][number];
  compact?: boolean;
}) {
  const { t, i18n } = useTranslation("pullRequests");
  const state = resolvePullRequestState(
    {
      state: layer.state,
      isDraft: layer.isDraft ?? false,
    },
    t,
  );
  return (
    <>
      <state.Icon aria-hidden className={cn("size-4 shrink-0", state.toneClassName)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{layer.title || layer.headBranch}</span>
        <span className="block truncate text-xs font-normal text-muted-foreground">
          #
          {new Intl.NumberFormat(i18n.resolvedLanguage, { useGrouping: false }).format(
            layer.number,
          )}{" "}
          · {compact ? null : `${layer.headBranch} · `}
          {state.label}
        </span>
      </span>
    </>
  );
}
