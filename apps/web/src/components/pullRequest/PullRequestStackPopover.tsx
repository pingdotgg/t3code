import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import type { EnvironmentId, PullRequestRef, PullRequestStackMembership } from "@t3tools/contracts";
import { LayersIcon } from "lucide-react";
import { useState } from "react";
import { pullRequestStackAtom } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { Menu, MenuTrigger, MenuPopup, MenuGroup, MenuGroupLabel } from "../ui/menu";
import { PullRequestStackLayers } from "./PullRequestStackLayers";

/** Mounted only while the menu is open, so list rows do not each fetch a stack. */
function StackBody({
  environmentId,
  reference,
  onSelect,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  onSelect: (reference: PullRequestRef) => void;
}) {
  const query = useEnvironmentQuery(pullRequestStackAtom({ environmentId, input: reference }));
  if (query.data !== null) {
    return <PullRequestStackLayers stack={query.data} reference={reference} onSelect={onSelect} />;
  }
  return (
    <MenuGroupLabel>
      {query.error ??
        (query.isPending ? "Loading stack…" : "This pull request is no longer in a stack.")}
    </MenuGroupLabel>
  );
}

export function PullRequestStackPopover({
  environmentId,
  reference,
  membership,
  onSelect,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  membership: PullRequestStackMembership;
  onSelect: (reference: PullRequestRef) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              nativeButton={false}
              render={
                <span
                  role="button"
                  tabIndex={0}
                  className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-xs font-normal text-muted-foreground"
                />
              }
              aria-label={`Stack ${membership.number}, layer ${membership.position} of ${membership.size}`}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <LayersIcon aria-hidden className="size-3" />
              {membership.position}/{membership.size}
            </MenuTrigger>
          }
        />
        <TooltipPopup>
          View stack #{membership.number}, layer {membership.position} of {membership.size}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup
        align="start"
        className="w-96 max-w-[calc(100vw-2rem)]"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <MenuGroup>
          <MenuGroupLabel>Stack #{membership.number}</MenuGroupLabel>
          {open ? (
            <StackBody
              environmentId={environmentId}
              reference={reference}
              onSelect={(target) => {
                setOpen(false);
                onSelect(target);
              }}
            />
          ) : null}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
