import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import {
  BotIcon,
  ListTodoIcon,
  LockIcon,
  LockOpenIcon,
  PencilRulerIcon,
  PenLineIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";

const runtimeModeConfig: Record<
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
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
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
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onTogglePlanSidebar: () => void;
}) {
  const runtimeModeOption = runtimeModeConfig[props.runtimeMode];
  const RuntimeModeIcon = runtimeModeOption.icon;
  const interactionModeTooltip =
    props.interactionMode === "plan"
      ? "Plan mode — click to return to normal build mode"
      : "Default mode — click to enter plan mode";
  const planSidebarTooltip = props.planSidebarOpen
    ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
    : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`;

  const interactionModeToggle = props.showInteractionModeToggle ? (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              className={cn(
                "shrink-0 whitespace-nowrap",
                props.interactionMode === "plan"
                  ? "bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300"
                  : "text-muted-foreground/70 hover:text-foreground/80",
              )}
              type="button"
              onClick={props.onToggleInteractionMode}
              aria-label={interactionModeTooltip}
            />
          }
        >
          {props.interactionMode === "plan" ? (
            <ComposerControlIcon icon={PencilRulerIcon} className="text-current opacity-100" />
          ) : (
            <ComposerControlIcon icon={BotIcon} opticalSize="large" />
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
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

      <Tooltip>
        <Select
          value={props.runtimeMode}
          onValueChange={(value) => props.onRuntimeModeChange(value!)}
        >
          <TooltipTrigger
            render={<ComposerSelectControl className="font-medium" aria-label="Runtime mode" />}
          >
            <ComposerControlIcon icon={RuntimeModeIcon} />
            <SelectValue>{runtimeModeOption.label}</SelectValue>
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {runtimeModeOptions.map((mode) => {
              const option = runtimeModeConfig[mode];
              const OptionIcon = option.icon;
              return (
                <SelectItem key={mode} value={mode} hideIndicator className="min-w-64 py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                        <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        {option.label}
                      </span>
                      <span className="text-muted-foreground text-xs leading-4">
                        {option.description}
                      </span>
                    </div>
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
                <ComposerControl
                  className={cn(
                    "shrink-0 whitespace-nowrap",
                    props.planSidebarOpen
                      ? "bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300"
                      : "text-muted-foreground/70 hover:text-foreground/80",
                  )}
                  type="button"
                  onClick={props.onTogglePlanSidebar}
                  aria-label={planSidebarTooltip}
                />
              }
            >
              <ComposerControlIcon
                icon={ListTodoIcon}
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
