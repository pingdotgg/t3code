import type { RuntimeMode } from "@forma/contracts";
import { LockIcon, LockOpenIcon, PenLineIcon, type LucideIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

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
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];

export const ComposerRuntimeModeControl = memo(function ComposerRuntimeModeControl(props: {
  runtimeMode: RuntimeMode;
  runtimeModeLocked: boolean;
  runtimeModeLockReason?: string | undefined;
  triggerSize?: "sm" | "xs";
  className?: string | undefined;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const runtimeModeOption = runtimeModeConfig[props.runtimeMode];
  const RuntimeModeIcon = runtimeModeOption.icon;

  return (
    <Select
      value={props.runtimeMode}
      onValueChange={(value) => {
        if (!value || value === props.runtimeMode) {
          return;
        }
        props.onRuntimeModeChange(value as RuntimeMode);
      }}
    >
      <SelectTrigger
        variant="ghost"
        size={props.triggerSize ?? "xs"}
        className={cn("font-medium", props.className)}
        aria-label="Access mode"
        title={
          props.runtimeModeLocked ? props.runtimeModeLockReason : runtimeModeOption.description
        }
      >
        <RuntimeModeIcon className="size-3" />
        <SelectValue>{runtimeModeOption.label}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {runtimeModeOptions.map((mode) => {
          const option = runtimeModeConfig[mode];
          const OptionIcon = option.icon;
          const disabled = props.runtimeModeLocked && mode !== "approval-required";
          return (
            <SelectItem key={mode} value={mode} className="min-w-64 py-2" disabled={disabled}>
              <div className="grid min-w-0 gap-0.5">
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                  <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  {option.label}
                </span>
                <span className="text-muted-foreground text-xs leading-4">
                  {disabled ? `${option.description} Unavailable in ASK mode.` : option.description}
                </span>
              </div>
            </SelectItem>
          );
        })}
      </SelectPopup>
    </Select>
  );
});
