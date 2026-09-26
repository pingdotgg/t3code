import { MAX_INTERFACE_FONT_SIZE, MIN_INTERFACE_FONT_SIZE } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronRightIcon,
  MessageSquareTextIcon,
  PanelLeftIcon,
  PanelTopIcon,
  Undo2Icon,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useId, useRef } from "react";

import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useEnvironmentThemeDefinitions } from "../../hooks/useEnvironmentTheme";
import { useClientSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { type InterfaceSurfaceId } from "../../interfaceLayout";
import { cn } from "../../lib/utils";
import {
  getThemeCardDefinition,
  previewColorsOf,
  STANDARD_THEME_CARDS,
  type ThemeCardDefinition,
  ThemePreviewCircle,
} from "../settings/ThemePreviewCircles";
import { MAINTAINER_THEMES, useThemeSelection } from "../settings/ThemeSettings";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { type EditSurface, useCustomizeInterfaceStore } from "./customizeInterfaceStore";
import {
  matchPreset,
  type Preset,
  type PresetId,
  PRESETS,
  surfaceVisibility,
} from "./customizePresets";
import { useCustomizeActions, useHasCustomizeChanges } from "./useCustomizeActions";

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      size="sm"
      className="w-44 *:flex-1"
      value={[value]}
      onValueChange={(next) => {
        const selected = options.find((option) => option.value === next[0]);
        if (selected) onChange(selected.value);
      }}
    >
      {options.map((option) => (
        <Toggle key={option.value} value={option.value}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

function Row({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-9 items-center gap-3 px-4">
      <label htmlFor={htmlFor} className="min-w-0 flex-1 truncate text-sm">
        {label}
      </label>
      {children}
    </div>
  );
}

// ── Presets ─────────────────────────────────────────────────────────────

/** A schematic of the app: sidebar rows, the chat column, and the composer. */
function PresetThumbnail({ id }: { id: PresetId }) {
  const sidebarWidth = id === "focus" ? 12 : id === "detailed" ? 38 : 32;
  const rows = id === "detailed" ? 5 : 4;
  const rowGap = 44 / rows;
  const composerLeft = id === "focus" ? 44 : sidebarWidth + 10;
  const composerRight = id === "focus" ? 88 : id === "detailed" ? 124 : 116;
  return (
    <svg aria-hidden viewBox="0 0 132 56" className="h-14 w-full text-foreground">
      <rect x="0" y="0" width="132" height="56" rx="6" className="fill-background" />
      <rect x="0" y="0" width={sidebarWidth} height="56" className="fill-foreground/5" />
      {id === "focus"
        ? null
        : Array.from({ length: rows }, (_, index) => {
            const y = 7 + index * rowGap;
            return (
              <g key={index}>
                <rect
                  x="5"
                  y={y}
                  width={sidebarWidth - 11}
                  height="3"
                  rx="1.5"
                  className="fill-foreground/35"
                />
                {id === "minimal" ? null : (
                  <rect
                    x="5"
                    y={y + 5}
                    width={sidebarWidth - 17}
                    height="2"
                    rx="1"
                    className="fill-foreground/18"
                  />
                )}
                {id === "detailed" ? (
                  <rect
                    x={sidebarWidth - 9}
                    y={y + 5}
                    width="4"
                    height="2"
                    rx="1"
                    className="fill-primary/60"
                  />
                ) : null}
              </g>
            );
          })}
      <rect
        x={composerLeft}
        y="40"
        width={composerRight - composerLeft}
        height="10"
        rx="4"
        className="fill-foreground/10"
      />
      <rect
        x={composerLeft + 4}
        y="44"
        width="14"
        height="2.5"
        rx="1.25"
        className="fill-foreground/30"
      />
      {id === "minimal" || id === "focus" ? null : (
        <rect
          x={composerLeft + 22}
          y="44"
          width="10"
          height="2.5"
          rx="1.25"
          className="fill-foreground/20"
        />
      )}
      {id === "focus" ? null : (
        <rect x="112" y="5" width="14" height="4" rx="2" className="fill-foreground/15" />
      )}
    </svg>
  );
}

function PresetCard({
  preset,
  selected,
  onApply,
}: {
  preset: Preset;
  selected: boolean;
  onApply: () => void;
}) {
  const setPreview = useCustomizeInterfaceStore((store) => store.setPreviewPresetId);
  const previewing = useCustomizeInterfaceStore((store) => store.previewPresetId === preset.id);
  return (
    <button
      type="button"
      data-previewing={previewing || undefined}
      data-preset={preset.id}
      aria-pressed={selected}
      onClick={() => {
        onApply();
        setPreview(null);
      }}
      onPointerEnter={() => setPreview(preset.id)}
      onPointerLeave={() => setPreview(null)}
      onFocus={() => setPreview(preset.id)}
      onBlur={() => setPreview(null)}
      className={cn(
        "group/preset cursor-pointer rounded-xl border p-1.5 pb-2 text-left outline-none transition-[border-color,background-color,box-shadow] duration-150 motion-reduce:transition-none",
        "hover:border-primary/60 focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20",
        selected ? "border-foreground/20 bg-accent/60" : "border-border/70 bg-accent/15",
      )}
    >
      <PresetThumbnail id={preset.id} />
      <span className="mt-1.5 flex items-center gap-1 px-1 text-sm font-medium">
        {preset.label}
        {selected ? <CheckIcon aria-hidden className="size-3.5 text-primary" /> : null}
      </span>
      <span className="block truncate px-1 text-xs text-muted-foreground">
        {previewing ? "Preview · click to apply" : preset.description}
      </span>
    </button>
  );
}

// ── Appearance ──────────────────────────────────────────────────────────

interface ThemeSwatch {
  readonly key: string;
  readonly card: ThemeCardDefinition;
  /** Null is the built-in T3 Code theme. */
  readonly themeId: string | null;
  readonly apply: () => void;
}

function ThemeSwatches() {
  const {
    appearanceMode,
    resolvedTheme,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
  } = useTheme();
  const customThemes = useCustomThemes();
  const environmentThemes = useEnvironmentThemeDefinitions();
  const { withRecord } = useCustomizeActions();
  const selection = useThemeSelection({
    theme,
    setTheme,
    appearanceMode,
    setAppearanceMode,
    themeHalves,
    setThemeHalf,
  });
  const swatches: ThemeSwatch[] = [
    ...STANDARD_THEME_CARDS.map((card) => ({
      key: `standard:${card.id}`,
      card,
      themeId: null,
      apply: selection.applyStandardTheme,
    })),
    ...MAINTAINER_THEMES.map((definition) => ({
      key: `maintainer:${definition.id}`,
      card: getThemeCardDefinition(definition),
      themeId: definition.id,
      apply: () => void selection.persistTheme(definition.id),
    })),
    ...[
      ...environmentThemes.filter(
        (definition) => !customThemes.some((custom) => custom.id === definition.id),
      ),
      ...customThemes,
    ].map((definition) => ({
      key: `theme:${definition.id}`,
      card: getThemeCardDefinition(definition),
      themeId: definition.id,
      apply: () => selection.applyThemeDefinition(definition),
    })),
  ];
  return (
    <>
      <Row label="Theme">
        <TooltipProvider>
          <div
            role="radiogroup"
            aria-label="Theme"
            className="-me-1 flex max-w-56 flex-wrap justify-end gap-1"
          >
            {swatches.map((swatch) => {
              const preview =
                swatch.card.previews.find((candidate) => candidate.mode === resolvedTheme) ??
                swatch.card.previews[0];
              if (!preview) return null;
              const checked = selection.pickedModesFor(swatch.themeId).includes(resolvedTheme);
              return (
                <Tooltip key={swatch.key}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        aria-label={swatch.card.label}
                        onClick={() => withRecord(swatch.apply, "theme")}
                        className={cn(
                          "flex size-7 cursor-pointer items-center justify-center rounded-full outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                          checked && "ring-2 ring-primary ring-offset-1 ring-offset-popover",
                        )}
                      />
                    }
                  >
                    <ThemePreviewCircle
                      colors={previewColorsOf(swatch.card, preview.mode) ?? preview.colors}
                      mode={preview.mode}
                      className="size-5 border"
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{swatch.card.label}</TooltipPopup>
                </Tooltip>
              );
            })}
          </div>
        </TooltipProvider>
      </Row>
      <Row label="Appearance">
        <Segmented
          label="Appearance"
          value={appearanceMode}
          options={[
            { value: "system", label: "Auto" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
          onChange={(mode) => withRecord(() => selection.setMode(mode), "appearance")}
        />
      </Row>
    </>
  );
}

function TextSizeSlider() {
  const id = useId();
  const value = useClientSettings((settings) => settings.fontSizeInterface);
  const { commit } = useCustomizeActions();
  const min = MIN_INTERFACE_FONT_SIZE;
  const max = MAX_INTERFACE_FONT_SIZE;
  const ratio = (value - min) / (max - min);
  const style = {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
  return (
    <Row label="Text size" htmlFor={id}>
      <div className="flex w-44 items-center gap-2">
        <span aria-hidden className="text-2xs text-muted-foreground">
          A
        </span>
        <input
          id={id}
          type="range"
          className="settings-slider min-w-0 flex-1"
          min={min}
          max={max}
          step={1}
          value={value}
          style={style}
          aria-valuetext={`${value} pixels`}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            if (Number.isFinite(next)) commit({ fontSizeInterface: next }, "fontSizeInterface");
          }}
        />
        <span aria-hidden className="text-base text-muted-foreground">
          A
        </span>
      </div>
    </Row>
  );
}

// ── Fine-tune ───────────────────────────────────────────────────────────

const FINE_TUNE: ReadonlyArray<{
  surface: EditSurface;
  label: string;
  icon: ReactNode;
  layoutSurfaces: ReadonlyArray<InterfaceSurfaceId>;
  noun: string;
}> = [
  {
    surface: "threadRow",
    label: "Thread rows",
    icon: <PanelLeftIcon />,
    layoutSurfaces: ["threadRow"],
    noun: "details",
  },
  {
    surface: "chatHeader",
    label: "Header",
    icon: <PanelTopIcon />,
    layoutSurfaces: ["chatHeader"],
    noun: "actions",
  },
  {
    surface: "composer",
    label: "Composer",
    icon: <MessageSquareTextIcon />,
    layoutSurfaces: ["composerToolbar", "composerContextBar"],
    noun: "controls",
  },
];

/**
 * The mode's home: presets to start from, the appearance settings people
 * change most, and a way into editing each surface in place.
 */
export function CustomizePopover({
  className,
  style,
  returnFocusTo,
  onDone,
  onOpenSettings,
}: {
  className?: string;
  style?: CSSProperties;
  /** The fine-tune row to focus when coming back from editing that surface. */
  returnFocusTo: EditSurface | null;
  onDone: () => void;
  onOpenSettings: () => void;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  // Take focus from whatever opened the mode (the command palette hands it
  // back to the composer), so Escape and Undo reach the mode.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const section = sectionRef.current;
      const target =
        (returnFocusTo &&
          section?.querySelector<HTMLElement>(`[data-fine-tune="${returnFocusTo}"]`)) ??
        section?.querySelector<HTMLElement>('[data-preset][aria-pressed="true"]') ??
        section?.querySelector<HTMLElement>("[data-preset]");
      target?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      useCustomizeInterfaceStore.getState().setPreviewPresetId(null);
    };
  }, [returnFocusTo]);
  const presetSettings = useClientSettings((settings) => ({
    interfaceLayout: settings.interfaceLayout,
    chatWidth: settings.chatWidth,
    contextWindowMeterEnabled: settings.contextWindowMeterEnabled,
  }));
  const chatWidth = presetSettings.chatWidth;
  const matched = matchPreset(presetSettings);
  const historyLength = useCustomizeInterfaceStore((store) => store.history.length);
  const setEditing = useCustomizeInterfaceStore((store) => store.setEditing);
  const hasChanges = useHasCustomizeChanges();
  const { commit, undo, revert } = useCustomizeActions();
  return (
    <section
      ref={sectionRef}
      aria-label="Customize interface"
      data-customize-popover
      className={cn(
        "dialog-glass pointer-events-auto fixed z-[106] flex flex-col overflow-hidden rounded-2xl border text-popover-foreground shadow-lg/10",
        className,
      )}
      style={style}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-baseline gap-2">
            <h2 className="flex-1 text-sm font-semibold">Customize</h2>
            <span className="text-xs text-muted-foreground">
              {matched === null ? "Custom layout" : "Start from a layout"}
            </span>
          </div>
          <div role="group" aria-label="Layouts" className="mt-3 grid grid-cols-2 gap-2">
            {PRESETS.map((preset) => (
              <PresetCard
                key={preset.id}
                preset={preset}
                selected={matched === preset.id}
                onApply={() => {
                  if (matched !== preset.id) commit(preset.settings);
                }}
              />
            ))}
          </div>
        </div>
        <div className="border-t border-border/70 py-1.5">
          <ThemeSwatches />
          <TextSizeSlider />
          <Row label="Chat width">
            <Segmented
              label="Chat width"
              value={chatWidth}
              options={[
                { value: "comfortable", label: "Comfy" },
                { value: "wide", label: "Wide" },
                { value: "full", label: "Full" },
              ]}
              onChange={(next) => commit({ chatWidth: next })}
            />
          </Row>
        </div>
        <nav aria-label="Fine-tune" className="border-t border-border/70 py-1.5">
          {FINE_TUNE.map((entry) => {
            const counts = entry.layoutSurfaces
              .map((surface) => surfaceVisibility(surface, presetSettings.interfaceLayout))
              .reduce((sum, next) => ({
                shown: sum.shown + next.shown,
                total: sum.total + next.total,
              }));
            return (
              <button
                key={entry.surface}
                type="button"
                data-fine-tune={entry.surface}
                onClick={() => setEditing(entry.surface)}
                className="flex h-9 w-full cursor-pointer items-center gap-3 px-4 text-left text-sm outline-none hover:bg-accent/50 focus-visible:bg-accent/60 [&_svg]:size-4 [&_svg]:shrink-0"
              >
                <span className="text-muted-foreground">{entry.icon}</span>
                <span className="flex-1">{entry.label}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {counts.shown} of {counts.total} {entry.noun}
                </span>
                <ChevronRightIcon className="text-muted-foreground/70" />
              </button>
            );
          })}
        </nav>
      </div>
      <div className="flex items-center gap-1.5 border-t border-border/70 px-3 py-2.5">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Undo last change"
          disabled={historyLength === 0}
          onClick={undo}
        >
          <Undo2Icon />
        </Button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="min-w-0 flex-1 cursor-pointer truncate text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
        >
          Fonts and more in Settings
        </button>
        <Button size="sm" variant="ghost" disabled={!hasChanges} onClick={revert}>
          Revert
        </Button>
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </section>
  );
}
