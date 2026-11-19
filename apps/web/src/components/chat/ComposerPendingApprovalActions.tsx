import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
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
  {
    decision: "cancel",
    label: msg("Cancel", { $context: "verb, response to an approval request" }),
  },
  {
    decision: "decline",
    label: msg("Deny", { $context: "verb, response to an approval request" }),
  },
  { decision: "acceptForSession", label: msg("Always allow this session") },
  {
    decision: "accept",
    label: msg("Allow", { $context: "verb, response to an approval request" }),
  },
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
  const gt = useGT();
  const m = useMessages();
  // Provider options carry server-authored labels; only the built-in defaults are translated.
  const defaultOptions = options === DEFAULT_APPROVAL_OPTIONS;
  const optionLabel = (label: string) => (defaultOptions ? m(label) : label);
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
          {optionLabel(sessionOption.label)}
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
              render={
                <Button size="icon-sm" variant="ghost" aria-label={gt("More approval options")} />
              }
            >
              {gt("More", { $context: "button that opens more approval options" })}
            </MenuTrigger>
            <MenuPopup {...composerFloatingLayerProps} side="top" align="end" width="content">
              {moreOptions.map((option) => (
                <MenuOption
                  key={option.decision}
                  option={option}
                  label={optionLabel(option.label)}
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
                  {designLabels && (defaultOptions || decline.label === "Deny")
                    ? gt("Decline", { $context: "verb, response to an approval request" })
                    : optionLabel(decline.label)}
                </span>
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
                  {designLabels && (defaultOptions || primary.label === "Allow")
                    ? gt("Approve", { $context: "verb, response to an approval request" })
                    : optionLabel(primary.label)}
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
  label,
  disabled,
  onSelect,
}: {
  option: ProviderApprovalOption;
  label: string;
  disabled: boolean;
  onSelect: () => void;
}) {
  const item = (
    <MenuItem disabled={disabled} aria-description={option.warning} onClick={onSelect}>
      {option.warning ? <TriangleAlertIcon className="size-3 text-warning" /> : null}
      <span className="min-w-0 whitespace-normal wrap-break-word">{label}</span>
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
