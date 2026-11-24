import { T, useGT } from "gt-react";
import { ChevronDownIcon, ShieldIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Sits `bottom` pixels up, clear of the composer and its attached banners. The summary names
 * what waits at the end of the timeline, which is out of view while it shows.
 */
export function ScrollToEndButton(props: {
  readonly visible: boolean;
  readonly bottom: number;
  readonly summary: ReadonlyArray<string>;
  readonly pendingApprovalCount?: number | undefined;
  readonly pendingSubagentApprovalCount?: number | undefined;
  readonly onScrollToEnd: () => void;
}) {
  const gt = useGT();
  const ownApprovals = props.pendingApprovalCount ?? 0;
  const subagentApprovals = props.pendingSubagentApprovalCount ?? 0;
  const totalApprovals = ownApprovals + subagentApprovals;
  const hasApprovalWaiting = totalApprovals > 0;
  const approvalLabel =
    ownApprovals > 0
      ? totalApprovals === 1
        ? gt("Approval waiting")
        : gt("{count} approvals waiting", { count: totalApprovals })
      : subagentApprovals === 1
        ? gt("Subagent approval waiting")
        : gt("{count} subagent approvals waiting", { count: subagentApprovals });

  const button = (
    <Button
      data-scroll-to-end="true"
      data-approval-waiting={hasApprovalWaiting ? "true" : undefined}
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onScrollToEnd}
      className="pointer-events-auto"
      size="xs"
      variant="floating"
    >
      {hasApprovalWaiting ? (
        <ShieldIcon aria-hidden className="size-3.5 text-warning-foreground" />
      ) : null}
      {hasApprovalWaiting ? approvalLabel : <T>Scroll to end</T>}
      <ChevronDownIcon aria-hidden className="size-3.5" />
    </Button>
  );
  return (
    <div
      className="chat-scroll-to-bottom pointer-events-none absolute z-30 flex justify-center py-1.5"
      data-visible={props.visible}
      inert={!props.visible}
      style={{ bottom: props.bottom }}
    >
      {props.summary.length > 0 ? (
        <Tooltip>
          <TooltipTrigger render={button} />
          <TooltipPopup>
            {props.summary.map((part) => (
              <span className="block" key={part}>
                {part}
              </span>
            ))}
          </TooltipPopup>
        </Tooltip>
      ) : (
        button
      )}
    </div>
  );
}
