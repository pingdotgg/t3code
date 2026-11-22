import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { memo } from "react";
import { EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { Button, InlineButton } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ComposerPendingApprovalActionsProps {
  /** `card` leads with the accept choices and keeps the session-wide one visible. */
  presentation?: "composer" | "inline" | "card";
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
  {
    decision: "cancel",
    label: msg("Cancel", { $context: "verb, response to an approval request" }),
  },
  {
    decision: "decline",
    label: msg("Decline", { $context: "verb, response to an approval request" }),
  },
  { decision: "acceptForSession", label: msg("Always allow this session") },
  {
    decision: "accept",
    label: msg("Approve", { $context: "verb, response to an approval request" }),
  },
] satisfies ReadonlyArray<ProviderApprovalOption>;

const CARD_PRIMARY_DECISIONS: ReadonlyArray<ProviderApprovalDecision> = [
  "accept",
  "acceptForSession",
  "decline",
];

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  presentation = "composer",
  requestId,
  isResponding,
  canRespond,
  disabled = false,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const gt = useGT();
  const m = useMessages();
  // Provider options carry server-authored labels; only the built-in defaults are translated.
  const optionLabel = (label: string) => (options === DEFAULT_APPROVAL_OPTIONS ? m(label) : label);
  const primaryDecisions: ReadonlyArray<ProviderApprovalDecision> =
    presentation === "card" ? CARD_PRIMARY_DECISIONS : ["decline", "accept"];
  const primaryOptions = options.filter((option) => primaryDecisions.includes(option.decision));
  if (presentation === "card") {
    primaryOptions.sort(
      (a, b) => primaryDecisions.indexOf(a.decision) - primaryDecisions.indexOf(b.decision),
    );
  }
  const moreOptions = options.filter((option) => !primaryDecisions.includes(option.decision));

  return (
    <>
      {primaryOptions.map((option) => {
        const buttonProps = {
          disabled: disabled || isResponding || !canRespond,
          "aria-description": option.warning,
          onClick: () => {
            if (!disabled && !isResponding && canRespond) {
              void onRespondToApproval(requestId, option.decision);
            }
          },
        };
        const content = (
          <>
            {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span
              className={
                presentation === "inline"
                  ? "whitespace-normal"
                  : presentation === "card"
                    ? "whitespace-nowrap"
                    : "max-w-40 truncate"
              }
            >
              {optionLabel(option.label)}
            </span>
          </>
        );
        const button =
          presentation === "inline" ? (
            <InlineButton
              key={option.decision}
              {...buttonProps}
              tone={option.decision === "accept" ? "default" : "muted"}
            >
              {content}
            </InlineButton>
          ) : (
            <Button
              key={option.decision}
              {...buttonProps}
              size={presentation === "card" ? "sm" : "xs"}
              variant={option.decision === "accept" ? "default" : "outline"}
            >
              {content}
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
            disabled={disabled || isResponding || !canRespond}
            render={
              presentation === "inline" ? (
                <InlineButton tone="muted" aria-label={gt("More approval options")} />
              ) : (
                <Button
                  size={presentation === "card" ? "icon-sm" : "icon-xs"}
                  variant="outline"
                  aria-label={gt("More approval options")}
                />
              )
            }
          >
            {presentation === "inline" ? (
              gt("More", { $context: "button that opens more approval options" })
            ) : (
              <EllipsisIcon />
            )}
          </MenuTrigger>
          <MenuPopup {...composerFloatingLayerProps} side="top" align="end" width="content">
            {moreOptions.map((option) => {
              const item = (
                <MenuItem
                  key={option.decision}
                  disabled={disabled || isResponding || !canRespond}
                  aria-description={option.warning}
                  onClick={() => {
                    if (!disabled && !isResponding && canRespond)
                      void onRespondToApproval(requestId, option.decision);
                  }}
                >
                  {option.warning ? <TriangleAlertIcon className="size-3 text-warning" /> : null}
                  <span className="min-w-0 whitespace-normal wrap-break-word">
                    {optionLabel(option.label)}
                  </span>
                </MenuItem>
              );
              return option.warning ? (
                <Tooltip key={option.decision}>
                  <TooltipTrigger render={item} />
                  <TooltipPopup side="top">{option.warning}</TooltipPopup>
                </Tooltip>
              ) : (
                item
              );
            })}
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );
});
