import type { ProviderInteractionMode, RuntimeMode } from "@pathwayos/contracts";
import { memo } from "react";
import {
  BotIcon,
  ListTodoIcon,
  LockIcon,
  PencilRulerIcon,
  PenLineIcon,
  ShieldCheckIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: ShieldCheckIcon,
  },
};

const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];

export const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  showInteractionModeToggle: boolean;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  showPlanToggle: boolean;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  showLeadingSeparator?: boolean;
  runtimeModeTriggerClassName?: string;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onTogglePlanSidebar: () => void;
}) {
  const runtimeModeOption = runtimeModeConfig[props.runtimeMode];
  const RuntimeModeIcon = runtimeModeOption.icon;
  const interactionModeTooltip =
    props.interactionMode === "plan"
      ? "Plan mode - click to return to normal build mode"
      : "Default mode - click to enter plan mode";
  const planSidebarTooltip = props.planSidebarOpen
    ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
    : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`;

  const interactionModeToggle = props.showInteractionModeToggle ? (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              className={cn(
                "shrink-0 whitespace-nowrap px-2 sm:px-3",
                props.interactionMode === "plan"
                  ? "bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300"
                  : "text-muted-foreground/70 hover:text-foreground/80",
              )}
              size="sm"
              type="button"
              onClick={props.onToggleInteractionMode}
              aria-label={interactionModeTooltip}
            />
          }
        >
          {props.interactionMode === "plan" ? (
            <PencilRulerIcon className="text-current opacity-100" />
          ) : (
            <BotIcon />
          )}
          <span className="sr-only sm:not-sr-only">
            {props.interactionMode === "plan" ? "Plan" : "Build"}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{interactionModeTooltip}</TooltipPopup>
      </Tooltip>
    </>
  ) : null;

  return (
    <>
      {props.showLeadingSeparator === false ? null : (
        <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
      )}

      <Tooltip>
        <Select
          value={props.runtimeMode}
          onValueChange={(value) => props.onRuntimeModeChange(value!)}
        >
          <TooltipTrigger
            render={
              <SelectTrigger
                variant="ghost"
                size="sm"
                className={cn("font-medium", props.runtimeModeTriggerClassName)}
                aria-label="Runtime mode"
              />
            }
          >
            <RuntimeModeIcon className="size-4" />
            <SelectValue>{runtimeModeOption.label}</SelectValue>
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {runtimeModeOptions.map((mode) => {
              const option = runtimeModeConfig[mode];
              const OptionIcon = option.icon;
              return (
                <SelectItem key={mode} value={mode} className="min-w-64 py-2">
                  <div className="grid min-w-0 gap-0.5">
                    <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                      <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      {option.label}
                    </span>
                    <span className="text-muted-foreground text-xs leading-4">
                      {option.description}
                    </span>
                  </div>
                </SelectItem>
              );
            })}
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">{runtimeModeOption.description}</TooltipPopup>
      </Tooltip>

      {interactionModeToggle}

      {props.showPlanToggle ? (
        <>
          <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  className={cn(
                    "shrink-0 whitespace-nowrap px-2 sm:px-3",
                    props.planSidebarOpen
                      ? "bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300"
                      : "text-muted-foreground/70 hover:text-foreground/80",
                  )}
                  size="sm"
                  type="button"
                  onClick={props.onTogglePlanSidebar}
                  aria-label={planSidebarTooltip}
                />
              }
            >
              <ListTodoIcon
                className={props.planSidebarOpen ? "text-current opacity-100" : undefined}
              />
              <span className="sr-only sm:not-sr-only">{props.planSidebarLabel}</span>
            </TooltipTrigger>
            <TooltipPopup side="top">{planSidebarTooltip}</TooltipPopup>
          </Tooltip>
        </>
      ) : null}
    </>
  );
});
