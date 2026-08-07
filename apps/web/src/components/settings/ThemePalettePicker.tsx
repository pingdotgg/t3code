"use client";

import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { CheckIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import {
  THEME_PALETTES,
  isThemePalette,
  type ThemePalette,
  type ThemePaletteDescriptor,
} from "~/lib/themePalettes";

/**
 * A miniature of the app painted entirely from semantic tokens. The
 * `data-theme-palette` attribute on the wrapper re-scopes those tokens to the
 * palette being previewed, so every card shows its own colors regardless of
 * which palette is currently active. Light/dark is inherited from the document,
 * so a card previews what you would actually get in the mode you are in.
 */
function ThemePalettePreview({ palette }: { palette: ThemePalette }) {
  return (
    <div
      aria-hidden
      data-theme-palette={palette}
      className="flex h-24 w-full overflow-hidden rounded-md border border-[var(--border)] bg-[var(--background)]"
    >
      <div className="w-1/4 shrink-0 border-[var(--sidebar-border)] border-r bg-[var(--sidebar)]" />
      <div className="flex min-w-0 flex-1 flex-col justify-between gap-2 p-2.5">
        <div className="space-y-1.5">
          <div className="h-2 w-3/5 rounded-full bg-[var(--foreground)]" />
          <div className="h-2 w-4/5 rounded-full bg-[var(--muted-foreground)]" />
        </div>
        <div className="flex justify-end">
          <div className="h-4 w-1/3 rounded-full bg-[var(--primary)]" />
        </div>
      </div>
    </div>
  );
}

function ThemePaletteCard({
  descriptor,
  selected,
}: {
  descriptor: ThemePaletteDescriptor;
  selected: boolean;
}) {
  return (
    <Radio.Root
      value={descriptor.id}
      // The visible label lives in a child, but Base UI renders the radio as a
      // bare button, so without this the option is unnamed to screen readers.
      aria-label={`${descriptor.label} — ${descriptor.description}`}
      className={cn(
        "group flex cursor-pointer flex-col gap-2.5 rounded-xl border p-2.5 text-left outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        selected ? "border-primary bg-accent/40" : "border-border hover:bg-accent/30",
      )}
    >
      <ThemePalettePreview palette={descriptor.id} />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <div className="truncate font-medium text-[13px] text-foreground">{descriptor.label}</div>
          <div className="text-[12px] leading-[1.4] text-muted-foreground/80">
            {descriptor.description}
          </div>
        </div>
        <span
          className={cn(
            "mt-0.5 inline-flex size-4.5 shrink-0 items-center justify-center rounded-full transition-opacity",
            selected ? "bg-primary text-primary-foreground opacity-100" : "opacity-0",
          )}
        >
          <CheckIcon className="size-3" />
        </span>
      </div>
    </Radio.Root>
  );
}

export function ThemePalettePicker({
  value,
  onValueChange,
}: {
  value: ThemePalette;
  onValueChange: (palette: ThemePalette) => void;
}) {
  return (
    <RadioGroup
      aria-label="Theme"
      value={value}
      onValueChange={(next) => {
        if (isThemePalette(next)) onValueChange(next);
      }}
      className="mt-3 grid grid-cols-1 gap-3 pb-3.5 sm:grid-cols-2 lg:grid-cols-3"
    >
      {THEME_PALETTES.map((descriptor) => (
        <ThemePaletteCard
          key={descriptor.id}
          descriptor={descriptor}
          selected={descriptor.id === value}
        />
      ))}
    </RadioGroup>
  );
}
