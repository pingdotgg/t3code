import { BanIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import {
  PROJECT_COLOR_OPTIONS,
  PROJECT_COLOR_VALUES,
  projectColorCssValue,
  type ProjectColorName,
} from "../projectColors";

/**
 * Small color swatch that marks a project wherever its name shows, so repos
 * can be told apart by color alone. Renders nothing when no color is set —
 * the accompanying text already names the project, so the dot stays
 * decorative for assistive tech.
 */
export function ProjectColorDot(props: {
  color: string | null | undefined;
  className?: string | undefined;
}) {
  const value = projectColorCssValue(props.color);
  if (!value) {
    return null;
  }
  return (
    <span
      aria-hidden
      data-testid="project-color-dot"
      className={cn("size-2 shrink-0 rounded-full", props.className)}
      style={{ backgroundColor: value }}
    />
  );
}

/**
 * Swatch row for picking a project color, with a leading "no color" option.
 * Swatches carry color-name labels so the choice is announced, not just
 * shown.
 */
export function ProjectColorPicker(props: {
  value: string | null;
  onChange: (color: ProjectColorName | null) => void;
  disabled?: boolean | undefined;
}) {
  return (
    <div role="group" aria-label="Project color" className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        aria-label="No color"
        aria-pressed={props.value === null}
        disabled={props.disabled}
        onClick={() => props.onChange(null)}
        className={cn(
          "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border text-icon-muted outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          props.value === null && "ring-2 ring-ring ring-offset-1 ring-offset-background",
        )}
      >
        <BanIcon className="size-3" />
      </button>
      {PROJECT_COLOR_OPTIONS.map((option) => (
        <button
          key={option.name}
          type="button"
          aria-label={option.label}
          aria-pressed={props.value === option.name}
          disabled={props.disabled}
          onClick={() => props.onChange(option.name)}
          className={cn(
            "size-5 shrink-0 cursor-pointer rounded-full outline-none transition-transform focus-visible:ring-2 focus-visible:ring-ring active:scale-90 disabled:cursor-not-allowed disabled:opacity-50",
            props.value === option.name && "ring-2 ring-ring ring-offset-1 ring-offset-background",
          )}
          style={{ backgroundColor: PROJECT_COLOR_VALUES[option.name] }}
        />
      ))}
    </div>
  );
}
