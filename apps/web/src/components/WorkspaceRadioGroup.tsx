import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useState, type ReactNode } from "react";

interface WorkspaceRadioGroupProps {
  label: string;
  shortcut: string;
  value: string;
  disabled: boolean;
  title?: string | undefined;
  options: readonly { value: string; label: string; content: ReactNode }[];
  onSelect: (value: string) => void;
}

/** Arrow keys explore workspace options; Enter or Space commits the choice. */
export function WorkspaceRadioGroup({
  label,
  shortcut,
  value,
  disabled,
  title,
  options,
  onSelect,
}: WorkspaceRadioGroupProps) {
  const [focusedValue, setFocusedValue] = useState<string | null>(null);
  const tabValue = focusedValue ?? value;
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled}
      data-workspace-group={shortcut}
      className="min-w-0"
      onKeyDown={(event) => {
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            'button[role="radio"]:not(:disabled)',
          ),
        );
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        if (index < 0) return;
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : event.key === "ArrowDown"
                ? (index + 1) % buttons.length
                : event.key === "ArrowUp"
                  ? (index + buttons.length - 1) % buttons.length
                  : null;
        if (next !== null) {
          event.preventDefault();
          event.stopPropagation();
          buttons[next]?.focus();
        }
      }}
    >
      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{label}</div>
      {options.map((option, index) => (
        <Tooltip key={option.value}>
          <TooltipTrigger render={<span className="block" />}>
            <button
              type="button"
              role="radio"
              aria-checked={value === option.value}
              tabIndex={
                tabValue === option.value ||
                (!options.some((item) => item.value === tabValue) && index === 0)
                  ? 0
                  : -1
              }
              disabled={disabled}
              onFocus={() => setFocusedValue(option.value)}
              onClick={() => onSelect(option.value)}
              className="flex min-h-8 w-full cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1 text-left text-base hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 aria-checked:bg-foreground/[0.08] sm:min-h-7 sm:text-sm"
            >
              {option.content}
            </button>
          </TooltipTrigger>
          <TooltipPopup>{title ? `${option.label} · ${title}` : option.label}</TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}
