import { IconCheckmark as CheckIcon } from "symbols-react";

import { cn } from "../../lib/utils";
import {
  THEME_OPTIONS,
  getThemeMetadata,
  type ResolvedThemePreset,
  type ThemePreference,
} from "../../theme";
import { RadioGroupPrimitive, RadioPrimitive } from "../ui/radio-group";

const THEME_SELECTOR_CARD_CLASS_NAME =
  "relative isolate text-left whitespace-normal transition-[color,box-shadow,opacity] duration-150 ease-out hover:ring-2 hover:ring-foreground/6 focus-visible:ring-2 focus-visible:ring-ring/18 data-checked:ring-2 data-checked:ring-primary/18 data-disabled:cursor-not-allowed data-disabled:opacity-64";

const THEME_SELECTOR_INDICATOR_CLASS_NAME =
  "inline-flex items-center justify-center text-primary data-unchecked:scale-90 data-unchecked:opacity-0 [transition:opacity_var(--motion-duration-ui)_var(--motion-ease-in-out),transform_var(--motion-duration-ui)_var(--motion-ease-in-out)]";

function ThemePrimarySwatch({
  className,
  preset,
  selected = false,
}: {
  className?: string;
  preset: ResolvedThemePreset;
  selected?: boolean;
}) {
  const metadata = getThemeMetadata(preset);

  return (
    <span
      className={cn(
        "theme-preview inline-flex shrink-0 rounded-full border border-border/70 bg-primary shadow-sm/5",
        metadata.mode === "dark" && "dark",
        className,
      )}
      data-theme-preview={preset}
      data-theme-selected-swatch={selected ? "true" : undefined}
    />
  );
}

export function ThemePreferenceSelector({
  theme,
  resolvedPreset,
  onChange,
}: {
  theme: ThemePreference;
  resolvedPreset: ResolvedThemePreset;
  onChange: (next: ThemePreference) => void;
}) {
  const systemOption = THEME_OPTIONS[0]!;
  const presetOptions = THEME_OPTIONS.slice(1) as ReadonlyArray<{
    value: ResolvedThemePreset;
    label: string;
  }>;
  const resolvedSystemTheme = getThemeMetadata(resolvedPreset);
  const orderedPresetOptions = [
    ...presetOptions.filter((option) => getThemeMetadata(option.value).mode === "light"),
    ...presetOptions.filter((option) => getThemeMetadata(option.value).mode === "dark"),
  ];
  const selectedPreviewPreset = theme === "system" ? resolvedPreset : theme;
  const selectedThemeLabel = getThemeMetadata(selectedPreviewPreset).label;
  const selectedThemeDetail = theme === "system" ? "System" : null;

  return (
    <RadioGroupPrimitive<ThemePreference>
      aria-label="Theme preference"
      className="space-y-3 pb-2"
      onValueChange={onChange}
      value={theme}
    >
      <div className="flex items-center justify-between gap-3 px-0.5">
        <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground/64">
          Selected
        </span>
        <span className="flex min-w-0 items-center justify-end gap-2 text-right">
          <ThemePrimarySwatch className="size-3" preset={selectedPreviewPreset} selected />
          <span
            className="truncate font-medium text-sm text-foreground"
            data-theme-selected-label="true"
          >
            {selectedThemeLabel}
          </span>
          {selectedThemeDetail ? (
            <span
              className="truncate text-xs text-muted-foreground"
              data-theme-selected-detail="true"
            >
              {selectedThemeDetail}
            </span>
          ) : null}
        </span>
      </div>

      <div className="flex flex-col gap-3">
        <RadioPrimitive.Root
          className={cn(
            THEME_SELECTOR_CARD_CLASS_NAME,
            "order-2 flex w-full cursor-pointer items-center gap-3 rounded-lg px-1.5 py-2 text-left outline-none text-muted-foreground/86 data-checked:text-foreground hover:text-foreground",
          )}
          data-theme-option={systemOption.value}
          value={systemOption.value}
        >
          <ThemePrimarySwatch className="size-2.5" preset={resolvedPreset} />

          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate font-medium text-sm">{systemOption.label}</span>
            <span className="truncate text-xs text-muted-foreground">
              Follow device setting. Currently {resolvedSystemTheme.label}.
            </span>
          </span>

          <RadioPrimitive.Indicator
            className={cn(THEME_SELECTOR_INDICATOR_CLASS_NAME, "size-4.5 shrink-0")}
          >
            <CheckIcon className="size-2.5" />
          </RadioPrimitive.Indicator>
        </RadioPrimitive.Root>

        <div
          className="order-1 grid grid-cols-2 gap-3 sm:grid-cols-4"
          data-theme-preset-grid="true"
        >
          {orderedPresetOptions.map((option) => {
            const previewMetadata = getThemeMetadata(option.value);

            return (
              <RadioPrimitive.Root
                aria-label={option.label}
                className={cn(
                  THEME_SELECTOR_CARD_CLASS_NAME,
                  "flex min-w-0 cursor-pointer rounded-xl p-1.5 outline-none",
                )}
                data-theme-option={option.value}
                key={option.value}
                title={option.label}
                value={option.value}
              >
                <RadioPrimitive.Indicator
                  className={cn(
                    THEME_SELECTOR_INDICATOR_CLASS_NAME,
                    "absolute top-2 right-2 size-4",
                  )}
                >
                  <CheckIcon className="size-2.5" />
                </RadioPrimitive.Indicator>

                <span className="sr-only">{option.label}</span>

                <span
                  className={cn(
                    "theme-preview relative flex min-h-[4.9rem] w-full flex-col overflow-hidden rounded-lg border border-border/70 bg-background p-2 shadow-sm/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
                    previewMetadata.mode === "dark" && "dark",
                  )}
                  data-theme-preview={option.value}
                >
                  <span className="flex items-center justify-between gap-1.5">
                    <span className="h-1.5 w-6 rounded-full bg-foreground/12" />
                    <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-card px-1 py-0.75 shadow-xs/5">
                      <span className="size-1 rounded-full bg-primary" />
                      <span className="h-1 w-2 rounded-full bg-foreground/10" />
                    </span>
                  </span>

                  <span className="mt-1.5 flex-1 rounded-md border border-border/70 bg-card/92 p-1.5 shadow-xs/5">
                    <span className="flex items-center gap-1">
                      <span className="size-3.5 rounded-[0.35rem] bg-primary/16" />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.75">
                        <span className="h-1 w-5 rounded-full bg-foreground/14" />
                        <span className="h-1 w-7 rounded-full bg-foreground/10" />
                      </span>
                    </span>

                    <span className="mt-1.5 flex items-center justify-between gap-1.5">
                      <span className="inline-flex h-3.5 w-6 rounded-full bg-muted" />
                      <span className="inline-flex h-3.5 w-8 rounded-full bg-primary/86" />
                    </span>
                  </span>
                </span>
              </RadioPrimitive.Root>
            );
          })}
        </div>
      </div>
    </RadioGroupPrimitive>
  );
}
