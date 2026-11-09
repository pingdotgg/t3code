import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import { memo } from "react";
import {
  CheckCheckIcon,
  CheckIcon,
  EllipsisIcon,
  type LucideIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ComposerPendingApprovalActionsProps {
  requestId: RuntimeRequestId;
  isResponding: boolean;
  canRespond: boolean;
  disabled?: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

// Approve first, then the standing grants, then Decline; anything else (Cancel) waits in the menu.
const BUTTON_ORDER: ReadonlyArray<ProviderApprovalDecision> = [
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
];

const DECISION_ICON: Record<ProviderApprovalDecision, LucideIcon> = {
  accept: CheckIcon,
  acceptForSession: CheckCheckIcon,
  acceptAlways: CheckCheckIcon,
  decline: XIcon,
  cancel: XIcon,
};

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  canRespond,
  disabled = false,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const blocked = disabled || isResponding || !canRespond;
  const respond = (decision: ProviderApprovalDecision) => {
    if (!blocked) void onRespondToApproval(requestId, decision);
  };
  const buttonOptions = BUTTON_ORDER.flatMap((decision) =>
    options.filter((option) => option.decision === decision),
  );
  const moreOptions = options.filter((option) => !BUTTON_ORDER.includes(option.decision));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {buttonOptions.map((option) => {
        const Icon = option.warning ? TriangleAlertIcon : DECISION_ICON[option.decision];
        const button = (
          <Button
            key={option.decision}
            size="xs"
            variant={option.decision === "accept" ? "default" : "outline"}
            disabled={blocked}
            aria-description={option.warning}
            onClick={() => respond(option.decision)}
          >
            <Icon aria-hidden />
            <span className="max-w-56 truncate">{option.label}</span>
          </Button>
        );
        return option.warning ? (
          <Tooltip key={option.decision}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top">{option.warning}</TooltipPopup>
          </Tooltip>
        ) : (
          button
        );
      })}
      {moreOptions.length > 0 ? (
        <Menu>
          <MenuTrigger
            disabled={blocked}
            render={<Button size="icon-xs" variant="ghost" aria-label="More approval options" />}
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup {...composerFloatingLayerProps} side="top" align="end" width="content">
            {moreOptions.map((option) => (
              <MenuItem
                key={option.decision}
                disabled={blocked}
                aria-description={option.warning}
                onClick={() => respond(option.decision)}
              >
                {option.warning ? <TriangleAlertIcon className="size-3 text-warning" /> : null}
                <span className="min-w-0 whitespace-normal wrap-break-word">{option.label}</span>
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
});
