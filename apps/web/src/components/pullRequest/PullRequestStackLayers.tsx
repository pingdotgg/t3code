import type { PullRequestRef, PullRequestStack } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { MenuItem, MenuGroupLabel } from "../ui/menu";
import { resolvePullRequestState } from "./pullRequestPresentation";

export function PullRequestStackLayers({
  stack,
  reference,
  onSelect,
  pending = false,
}: {
  stack: PullRequestStack;
  reference: PullRequestRef;
  onSelect?: ((reference: PullRequestRef) => void) | undefined;
  pending?: boolean;
}) {
  return (
    <div className="max-h-80 overflow-y-auto">
      {stack.layers.toReversed().map((layer) => {
        const state = resolvePullRequestState({
          state: layer.state,
          isDraft: layer.isDraft ?? false,
        });
        return (
          <MenuItem
            key={layer.number}
            onClick={() => {
              onSelect?.({ ...reference, number: layer.number });
            }}
            disabled={!onSelect || pending}
            aria-current={layer.number === reference.number ? "true" : undefined}
          >
            <state.Icon aria-hidden className={cn("size-4 shrink-0", state.toneClassName)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{layer.title || layer.headBranch}</span>
              <span className="block truncate text-xs font-normal text-muted-foreground">
                #{layer.number} · {layer.headBranch} · {state.label}
              </span>
            </span>
            {layer.number === reference.number ? (
              <CheckIcon aria-hidden className="size-3.5" />
            ) : null}
          </MenuItem>
        );
      })}
      <MenuGroupLabel>↳ {stack.base}</MenuGroupLabel>
    </div>
  );
}
