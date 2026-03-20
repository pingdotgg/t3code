import type { GitCommitMessageMode } from "@t3tools/contracts";
import { COMMIT_MODES, CUSTOM_COMMIT_TEMPLATES } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronRightIcon,
  GitBranchIcon,
  InfoIcon,
  Settings2Icon,
  SparklesIcon,
  SmileIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";

const COMMIT_MODE_ICONS: ReadonlyArray<{
  value: GitCommitMessageMode;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    value: "standard",
    icon: GitBranchIcon,
  },
  {
    value: "auto",
    icon: SparklesIcon,
  },
  {
    value: "gitmoji",
    icon: SmileIcon,
  },
  {
    value: "custom",
    icon: Settings2Icon,
  },
] as const;

interface CommitModeSelectorProps {
  value: GitCommitMessageMode;
  onChange: (value: GitCommitMessageMode) => void;
  commitMessage: string;
  onCommitMessageChange: (value: string) => void;
  disabled?: boolean;
}

export function CommitModeSelector({
  value,
  onChange,
  commitMessage,
  onCommitMessageChange,
  disabled = false,
}: CommitModeSelectorProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [templatePopoverOpen, setTemplatePopoverOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const lastAppliedTemplateRef = useRef<(typeof CUSTOM_COMMIT_TEMPLATES)[number] | null>(null);
  const previousValueRef = useRef<GitCommitMessageMode>(value);
  const commitMessageRef = useRef(commitMessage);

  useEffect(() => {
    commitMessageRef.current = commitMessage;
  }, [commitMessage]);

  useEffect(() => {
    if (previousValueRef.current !== value && lastAppliedTemplateRef.current) {
      const updatedMessage = commitMessageRef.current
        .replace(lastAppliedTemplateRef.current.prompt, "")
        .replace(/\n\n+/g, "\n\n")
        .trim();
      onCommitMessageChange(updatedMessage);
    }
    setSelectedTemplateId(null);
    lastAppliedTemplateRef.current = null;
    previousValueRef.current = value;
  }, [value, onCommitMessageChange]);

  const selectedModeConfig = COMMIT_MODES.find((mode) => mode.value === value);
  const SelectedModeIcon = COMMIT_MODE_ICONS.find((icon) => icon.value === value)?.icon;

  const handleTemplateSelect = (template: (typeof CUSTOM_COMMIT_TEMPLATES)[number]) => {
    let newMessage = commitMessage;

    if (lastAppliedTemplateRef.current) {
      newMessage = newMessage.replace(lastAppliedTemplateRef.current.prompt, "").trim();
    }

    newMessage = newMessage.trim() ? `${newMessage}\n\n${template.prompt}` : template.prompt;

    onCommitMessageChange(newMessage);
    setSelectedTemplateId(template.id);
    lastAppliedTemplateRef.current = template;
    setTemplatePopoverOpen(false);
  };

  const isTemplateSelected = (templateId: string) => selectedTemplateId === templateId;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">Commit style</span>
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                className="flex items-center rounded hover:bg-accent/50 transition-colors p-0.5"
              >
                <InfoIcon className="size-3.5 text-muted-foreground" />
              </button>
            }
          />
          <PopoverPopup side="top" align="start" sideOffset={8} tooltipStyle>
            <div className="space-y-2 p-2">
              <p className="font-medium text-xs">How commit messages are generated</p>
              <ul className="space-y-1.5 text-[10px] text-muted-foreground">
                {COMMIT_MODES.map((mode) => {
                  const Icon = COMMIT_MODE_ICONS.find((icon) => icon.value === mode.value)?.icon;
                  if (!Icon) return null;
                  return (
                    <li key={mode.value} className="space-y-0.5">
                      <div className="flex items-center gap-1">
                        <Icon className="size-2.5 shrink-0" />
                        <strong className="text-xs">{mode.label}:</strong>
                        <span>{mode.summary}</span>
                      </div>
                      <p className="text-[9px] opacity-80 pl-5">{mode.description}</p>
                    </li>
                  );
                })}
              </ul>
            </div>
          </PopoverPopup>
        </Popover>

        {selectedModeConfig && SelectedModeIcon && (
          <div className="flex items-center align-baseline gap-0.5 text-xs text-muted-foreground">
            <span>(</span>
            <SelectedModeIcon className="size-3 shrink-0" />
            <span>{selectedModeConfig.summary}</span>
            <span>)</span>
          </div>
        )}
      </div>
      <div className="grid grid-cols-4 gap-2">
        {COMMIT_MODES.map((mode) => {
          const Icon = COMMIT_MODE_ICONS.find((icon) => icon.value === mode.value)?.icon;
          if (!Icon) return null;
          return (
            <Button
              key={mode.value}
              variant={"outline"}
              size="xs"
              disabled={disabled}
              className={cn(value === mode.value && "border-primary")}
              onClick={() => onChange(mode.value)}
            >
              <Icon className="size-2.5 shrink-0" />
              <span className="text-xs font-medium">{mode.label}</span>
            </Button>
          );
        })}
      </div>

      {value === "custom" && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Select a template or enter custom instructions</p>
          <Popover open={templatePopoverOpen} onOpenChange={setTemplatePopoverOpen}>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-between"
                  disabled={disabled}
                >
                  <span className="text-xs">
                    {selectedTemplateId
                      ? `✓ ${CUSTOM_COMMIT_TEMPLATES.find((t) => t.id === selectedTemplateId)?.label || "Template applied"}`
                      : "Choose a template..."}
                  </span>
                  <ChevronRightIcon className="size-3.5" />
                </Button>
              }
            />
            <PopoverPopup align="start" side="top" sideOffset={8} className="w-80">
              <div className="space-y-1 p-1" role="menu" aria-label="Commit message templates">
                <p className="px-2 pt-1 text-[10px] font-medium text-muted-foreground">
                  PREDEFINED TEMPLATES
                </p>
                {CUSTOM_COMMIT_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => handleTemplateSelect(template)}
                    role="menuitem"
                    aria-selected={isTemplateSelected(template.id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                      "hover:bg-accent focus:bg-accent focus:outline-none",
                      "disabled:opacity-50 disabled:cursor-not-allowed",
                      isTemplateSelected(template.id) && "bg-accent/50",
                    )}
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">{template.label}</span>
                      <span className="text-[9px] text-muted-foreground">
                        {template.description}
                      </span>
                    </div>
                    {isTemplateSelected(template.id) && (
                      <CheckIcon className="size-3 shrink-0 text-success" aria-hidden="true" />
                    )}
                  </button>
                ))}
              </div>
            </PopoverPopup>
          </Popover>
          {commitMessage && selectedTemplateId && (
            <p className="text-[9px] text-muted-foreground">
              💡 Template applied to commit message below. Edit to customize.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
