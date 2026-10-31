import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import type { ReactElement } from "react";
import { ShieldIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ComposerPendingApprovalActionsProps {
  designLabels?: boolean;
  showShortcutHints?: boolean;
  requestId: RuntimeRequestId;
  isResponding: boolean;
  canRespond: boolean;
  disabled?: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  /** Selected state of "Always allow this session". */
  alwaysAllow?: boolean;
  onAlwaysAllowChange?: (checked: boolean) => void;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

export const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Deny" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Allow" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

/**
 * Allow sends accept, or accept for the session when
 * the session toggle is on. Providers that only advertise a broader accept get that.
 */
export function resolveApprovalPrimaryDecision(
  options: ReadonlyArray<ProviderApprovalOption>,
  alwaysAllow: boolean,
): ProviderApprovalOption | null {
  const accept = options.find((option) => option.decision === "accept");
  const acceptForSession = options.find((option) => option.decision === "acceptForSession");
  if (accept && acceptForSession && alwaysAllow) return acceptForSession;
  return (
    accept ??
    acceptForSession ??
    options.find((option) => option.decision === "acceptAlways") ??
    null
  );
}

export function ComposerPendingApprovalActions({
  designLabels = false,
  showShortcutHints = true,
  requestId,
  isResponding,
  canRespond,
  disabled: permissionDisabled = false,
  options = DEFAULT_APPROVAL_OPTIONS,
  alwaysAllow = false,
  onAlwaysAllowChange,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const accept = options.find((option) => option.decision === "accept");
  const acceptForSession = options.find((option) => option.decision === "acceptForSession");
  // Offer the session toggle only when it changes what Allow sends.
  const sessionOption = accept && acceptForSession ? acceptForSession : null;
  const primary = resolveApprovalPrimaryDecision(options, false);
  const decline = options.find((option) => option.decision === "decline");
  const moreOptions = options.filter(
    (option) =>
      option !== decline &&
      option !== primary &&
      option !== sessionOption &&
      option.decision !== primary?.decision,
  );
  const disabled = permissionDisabled || isResponding || !canRespond;
  const allowDecision =
    sessionOption && alwaysAllow ? sessionOption.decision : (primary?.decision ?? null);
  const allowWarning = sessionOption && alwaysAllow ? sessionOption.warning : primary?.warning;

  const withWarning = (warning: string | undefined, node: ReactElement) =>
    warning ? (
      <Tooltip>
        <TooltipTrigger render={node} />
        <TooltipPopup side="top">{warning}</TooltipPopup>
      </Tooltip>
    ) : (
      node
    );

  return (
    <div className="flex min-w-0 grow basis-72 flex-wrap items-center justify-end gap-2">
      {sessionOption ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled}
          aria-pressed={alwaysAllow}
          data-pressed={alwaysAllow ? "" : undefined}
          aria-description={sessionOption.warning}
          onClick={() => onAlwaysAllowChange?.(!alwaysAllow)}
        >
          <ShieldIcon aria-hidden />
          {sessionOption.label}
          {sessionOption.warning ? (
            <TriangleAlertIcon aria-hidden className="size-3 shrink-0 text-warning-foreground" />
          ) : null}
        </Button>
      ) : null}
      <div className="flex shrink-0 items-center gap-2">
        {moreOptions.length > 0 ? (
          <Menu>
            <MenuTrigger
              disabled={disabled}
              render={<Button size="icon-sm" variant="ghost" aria-label="More approval options" />}
            >
              More
            </MenuTrigger>
            <MenuPopup {...composerFloatingLayerProps} side="top" align="end" width="content">
              {moreOptions.map((option) => (
                <MenuOption
                  key={option.decision}
                  option={option}
                  disabled={disabled}
                  onSelect={() => void onRespondToApproval(requestId, option.decision)}
                />
              ))}
            </MenuPopup>
          </Menu>
        ) : null}
        {decline
          ? withWarning(
              decline.warning,
              <Button
                key="decline"
                size="sm"
                variant="secondary"
                disabled={disabled}
                aria-description={decline.warning}
                onClick={() => void onRespondToApproval(requestId, decline.decision)}
              >
                {decline.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
                <span className="max-w-40 truncate">
                  {designLabels && decline.label === "Deny" ? "Decline" : decline.label}
                </span>
                {designLabels && showShortcutHints ? <Kbd aria-hidden>esc</Kbd> : null}
              </Button>,
            )
          : null}
        {primary && allowDecision
          ? withWarning(
              allowWarning,
              <Button
                key="accept"
                size="sm"
                variant="default"
                disabled={disabled}
                aria-description={allowWarning}
                onClick={() => void onRespondToApproval(requestId, allowDecision)}
              >
                {allowWarning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
                <span className="max-w-40 truncate">
                  {designLabels && primary.label === "Allow" ? "Approve" : primary.label}
                </span>
                {designLabels && showShortcutHints ? <Kbd aria-hidden>⏎</Kbd> : null}
              </Button>,
            )
          : null}
      </div>
    </div>
  );
}

function MenuOption({
  option,
  disabled,
  onSelect,
}: {
  option: ProviderApprovalOption;
  disabled: boolean;
  onSelect: () => void;
}) {
  const item = (
    <MenuItem disabled={disabled} aria-description={option.warning} onClick={onSelect}>
      {option.warning ? <TriangleAlertIcon className="size-3 text-warning" /> : null}
      <span className="min-w-0 whitespace-normal wrap-break-word">{option.label}</span>
    </MenuItem>
  );
  return option.warning ? (
    <Tooltip>
      <TooltipTrigger render={item} />
      <TooltipPopup side="top">{option.warning}</TooltipPopup>
    </Tooltip>
  ) : (
    item
  );
}
