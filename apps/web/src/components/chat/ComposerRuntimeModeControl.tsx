import type { RuntimeMode } from "@t3tools/contracts";
import {
  IconLock as LockIcon,
  IconLockOpen as LockOpenIcon,
  IconPencilLine as PenLineIcon,
  IconSparkles as AutoIcon,
  type IconComponent,
} from "symbols-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: IconComponent }
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
    description: "Let an AI reviewer approve routine actions while risky ones still ask.",
    icon: AutoIcon,
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
  className?: string;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const selected = runtimeModeConfig[props.runtimeMode];
  const SelectedIcon = selected.icon;

  return (
    <Select
      value={props.runtimeMode}
      onValueChange={(value) => {
        if (!value || value === props.runtimeMode) return;
        props.onRuntimeModeChange(value as RuntimeMode);
      }}
    >
      <SelectTrigger
        variant="ghost"
        size="xs"
        className={cn("font-medium", props.className)}
        aria-label="Access mode"
        title={selected.description}
      >
        <SelectedIcon className="size-3 fill-current" />
        <SelectValue>{selected.label}</SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {runtimeModeOptions.map((mode) => {
          const option = runtimeModeConfig[mode];
          const OptionIcon = option.icon;
          return (
            <SelectItem key={mode} value={mode} className="min-w-64 py-2">
              <div className="grid min-w-0 gap-0.5">
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                  <OptionIcon className="size-3.5 shrink-0 fill-muted-foreground" />
                  {option.label}
                </span>
                <span className="text-xs leading-4 text-muted-foreground">
                  {option.description}
                </span>
              </div>
            </SelectItem>
          );
        })}
      </SelectPopup>
    </Select>
  );
});
