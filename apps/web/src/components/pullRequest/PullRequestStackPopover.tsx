import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import type { EnvironmentId, PullRequestRef, PullRequestStackMembership } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { useState } from "react";
import { usePullRequestStack } from "~/state/usePullRequestStack";
import { Menu, MenuTrigger, MenuPopup, MenuGroup, MenuGroupLabel, MenuItem } from "../ui/menu";
import { PullRequestStackLayers } from "./PullRequestStackLayers";
import { PullRequestStackHeader } from "./PullRequestStackHeader";
import { PullRequestGlyph } from "./pullRequestIcons";

// Mount only on open to avoid per-row stack fetches.
function StackBody({
  environmentId,
  reference,
  onSelect,
  stackNumber,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  onSelect: (reference: PullRequestRef) => void;
  stackNumber: number;
}) {
  const gt = useGT();
  const query = usePullRequestStack(environmentId, reference);
  if (query.data !== null) {
    return (
      <>
        <PullRequestStackHeader
          number={query.data.number}
          notice={query.notice}
          stale={!!query.error}
        />
        {query.error ? (
          <MenuItem onClick={query.refresh}>
            <T>Retry stack refresh</T>
          </MenuItem>
        ) : null}
        <PullRequestStackLayers stack={query.data} reference={reference} onSelect={onSelect} />
      </>
    );
  }
  return (
    <>
      <PullRequestStackHeader number={stackNumber} />
      <MenuGroupLabel>
        {query.error ??
          (query.isPending
            ? gt("Loading stack…")
            : gt("This pull request is no longer in a stack."))}
      </MenuGroupLabel>
    </>
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
  const gt = useGT();
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
              aria-label={gt("Stack {number}, layer {position} of {size}", {
                number: membership.number,
                position: membership.position,
                size: membership.size,
              })}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <PullRequestGlyph.stack aria-hidden className="size-3" />
              {membership.position}/{membership.size}
            </MenuTrigger>
          }
        />
        <TooltipPopup>
          <T>
            View stack #<Var>{membership.number}</Var>, layer <Var>{membership.position}</Var> of{" "}
            <Var>{membership.size}</Var>
          </T>
        </TooltipPopup>
      </Tooltip>
      <MenuPopup
        align="start"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <MenuGroup>
          {open ? (
            <StackBody
              environmentId={environmentId}
              reference={reference}
              stackNumber={membership.number}
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
