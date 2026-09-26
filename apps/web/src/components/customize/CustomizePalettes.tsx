import {
  type ClientSettings,
  type ClientSettingsPatch,
  DEFAULT_CLIENT_SETTINGS,
  type InterfaceLayout,
  MAX_APPEARANCE_CONTRAST,
  MAX_CODE_FONT_SIZE,
  MAX_GLASS_OPACITY,
  MAX_INTERFACE_FONT_SIZE,
  MAX_PANEL_ANIMATION_DURATION_MS,
  MAX_PROMPT_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_APPEARANCE_CONTRAST,
  MIN_CODE_FONT_SIZE,
  MIN_GLASS_OPACITY,
  MIN_INTERFACE_FONT_SIZE,
  MIN_PANEL_ANIMATION_DURATION_MS,
  MIN_PROMPT_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
} from "@t3tools/contracts";
import { CheckIcon, MinusIcon, PaintbrushIcon, PlusIcon } from "lucide-react";
import { type CSSProperties, useId } from "react";

import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useEnvironmentThemeDefinitions } from "../../hooks/useEnvironmentTheme";
import {
  getClientSettings,
  useClientSettings,
  useLegacySidebarEnabled,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import {
  INTERFACE_SURFACES,
  type InterfaceSurfaceId,
  isDefaultSurfaceLayout,
  moveSurfaceElement,
  resetSurfaceLayout,
  resolveSurfaceLayout,
  setSurfaceElementHidden,
} from "../../interfaceLayout";
import { cn, isMacPlatform } from "../../lib/utils";
import {
  getThemeDefinition,
  getThemeModes,
  type ThemeAppearance,
  type ThemeDefinition,
} from "../../themePalette";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import {
  getThemeCardDefinition,
  previewColorsOf,
  STANDARD_THEME_CARDS,
  type ThemeCardDefinition,
  ThemePreviewCircle,
} from "../settings/ThemePreviewCircles";
import { MAINTAINER_THEMES, useThemeSelection } from "../settings/ThemeSettings";
import { useThemeEditorStore } from "../settings/themeEditorStore";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { type ComposerPreview, useCustomizeInterfaceStore } from "./customizeInterfaceStore";
import { PaletteResetButton, PaletteRow, PaletteSection } from "./CustomizePalette";
import { type SortableElement, SortableElementList } from "./SortableElementList";

const selectInterfaceLayout = (settings: ClientSettings) => settings.interfaceLayout;

/** Element list state and edits for one surface. */
function useSurfaceEditor(surface: InterfaceSurfaceId) {
  const layout = useClientSettings(selectInterfaceLayout);
  const updateSettings = useUpdateClientSettings();
  const resolved = resolveSurfaceLayout(surface, layout);
  const definitions = new Map<string, (typeof INTERFACE_SURFACES)[typeof surface][number]>(
    INTERFACE_SURFACES[surface].map((element) => [element.id, element]),
  );
  const elements: SortableElement[] = resolved.order.map((id) => {
    const definition = definitions.get(id)!;
    return {
      id,
      label: definition.label,
      hidden: resolved.hidden.has(id as never),
      ...("description" in definition ? { description: definition.description } : {}),
      ...("required" in definition && definition.required ? { required: true } : {}),
      ...("sortable" in definition && definition.sortable ? {} : { fixed: true }),
    };
  });
  // Edits read the latest settings, not this render's: two quick edits (a
  // toggle, then a drag) must not rebuild the layout from a stale value.
  const edit = (next: (current: InterfaceLayout) => InterfaceLayout) =>
    void updateSettings({ interfaceLayout: next(getClientSettings().interfaceLayout) });
  return {
    elements,
    isDefault: isDefaultSurfaceLayout(surface, layout),
    move: (activeId: string, overId: string) =>
      edit((current) => moveSurfaceElement(current, surface, activeId, overId)),
    setHidden: (id: string, hidden: boolean) =>
      edit((current) => setSurfaceElementHidden(current, surface, id, hidden)),
    reset: () => edit((current) => resetSurfaceLayout(current, surface)),
  };
}

function SegmentedControl<T extends string>({
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
      className="w-full *:flex-1"
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

function PaletteSlider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const ratio = (value - min) / (max - min);
  const style = {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-sm text-foreground">
          {label}
        </label>
        <output htmlFor={id} className="font-mono text-xs text-muted-foreground tabular-nums">
          {value}
          {unit}
        </output>
      </div>
      <input
        id={id}
        type="range"
        className="settings-slider w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        style={style}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          if (Number.isFinite(next) && next >= min && next <= max) onChange(next);
        }}
      />
    </div>
  );
}

function SizeStepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <PaletteRow label={label}>
      <div className="flex items-center gap-0.5 rounded-lg bg-input/40 p-0.5">
        <Button
          aria-label={`Smaller ${label.toLowerCase()} text`}
          disabled={value <= min}
          size="icon-xs"
          variant="ghost"
          onClick={() => onChange(Math.max(min, value - 1))}
        >
          <MinusIcon />
        </Button>
        <output
          aria-label={`${label} text size`}
          className="w-11 text-center font-mono text-xs text-foreground tabular-nums"
        >
          {value}px
        </output>
        <Button
          aria-label={`Larger ${label.toLowerCase()} text`}
          disabled={value >= max}
          size="icon-xs"
          variant="ghost"
          onClick={() => onChange(Math.min(max, value + 1))}
        >
          <PlusIcon />
        </Button>
      </div>
    </PaletteRow>
  );
}

// ── Thread list ─────────────────────────────────────────────────────────

const TIMESTAMP_OPTIONS = [
  { value: "locale", label: "System" },
  { value: "12-hour", label: "12-hour" },
  { value: "24-hour", label: "24-hour" },
] as const;

export function ThreadListPaletteBody() {
  const editor = useSurfaceEditor("threadRow");
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const updateSettings = useUpdateClientSettings();
  return (
    <>
      <PaletteSection
        title="Thread rows"
        action={
          <PaletteResetButton
            label="Reset thread rows"
            disabled={editor.isDefault}
            onClick={editor.reset}
          />
        }
      >
        {legacySidebarEnabled ? (
          <p className="text-xs text-muted-foreground">
            Row details apply to the default sidebar. The legacy sidebar keeps its own layout.
          </p>
        ) : null}
        <SortableElementList
          label="Thread row details"
          elements={editor.elements}
          onMove={editor.move}
          onHiddenChange={editor.setHidden}
        />
      </PaletteSection>
      <PaletteSection title="Times">
        <SegmentedControl
          label="Time format"
          value={timestampFormat}
          options={TIMESTAMP_OPTIONS}
          onChange={(value) => void updateSettings({ timestampFormat: value })}
        />
      </PaletteSection>
    </>
  );
}

// ── Composer ────────────────────────────────────────────────────────────

const COMPOSER_PREVIEW_OPTIONS = [
  { value: "live", label: "Live" },
  { value: "expanded", label: "Expanded" },
  { value: "collapsed", label: "Collapsed" },
] as const satisfies ReadonlyArray<{ value: ComposerPreview; label: string }>;

export function ComposerPaletteBody() {
  const toolbar = useSurfaceEditor("composerToolbar");
  const contextBar = useSurfaceEditor("composerContextBar");
  const composerPreview = useCustomizeInterfaceStore((store) => store.composerPreview);
  const setComposerPreview = useCustomizeInterfaceStore((store) => store.setComposerPreview);
  const collapseOnScroll = useClientSettings((settings) => settings.composerCollapseOnScroll);
  const contextMeterEnabled = useClientSettings((settings) => settings.contextWindowMeterEnabled);
  const updateSettings = useUpdateClientSettings();
  // The model picker and send button frame the toolbar and can't move; the
  // context meter is its own setting, shown here where it appears.
  const toolbarElements: SortableElement[] = [
    { id: "model", label: "Model", hidden: false, required: true, fixed: true },
    ...toolbar.elements,
    {
      id: "contextMeter",
      label: "Context window meter",
      hidden: !contextMeterEnabled,
      fixed: true,
    },
    {
      id: "send",
      label: "Send and stop",
      description: "The only way to send",
      hidden: false,
      required: true,
      fixed: true,
    },
  ];
  return (
    <>
      <PaletteSection title="Preview">
        <SegmentedControl
          label="Composer preview"
          value={composerPreview}
          options={COMPOSER_PREVIEW_OPTIONS}
          onChange={setComposerPreview}
        />
      </PaletteSection>
      <PaletteSection
        title="Toolbar"
        action={
          <PaletteResetButton
            label="Reset toolbar"
            disabled={toolbar.isDefault}
            onClick={toolbar.reset}
          />
        }
      >
        <SortableElementList
          label="Composer toolbar"
          elements={toolbarElements}
          onMove={toolbar.move}
          onHiddenChange={(id, hidden) => {
            if (id === "contextMeter") {
              void updateSettings({ contextWindowMeterEnabled: !hidden });
              return;
            }
            toolbar.setHidden(id, hidden);
          }}
        />
      </PaletteSection>
      <PaletteSection
        title="Context bar"
        description="The strip under the composer. Model and mode join it while the composer is collapsed."
        action={
          <PaletteResetButton
            label="Reset context bar"
            disabled={contextBar.isDefault}
            onClick={contextBar.reset}
          />
        }
      >
        <SortableElementList
          label="Composer context bar"
          elements={contextBar.elements}
          onMove={contextBar.move}
          onHiddenChange={contextBar.setHidden}
        />
      </PaletteSection>
      <PaletteSection title="Behavior">
        <PaletteRow
          label="Collapse while reading"
          description="Shrinks to one line when you scroll back"
          htmlFor="customize-collapse-on-scroll"
        >
          <Switch
            id="customize-collapse-on-scroll"
            size="sm"
            checked={collapseOnScroll}
            onCheckedChange={(checked) =>
              void updateSettings({ composerCollapseOnScroll: Boolean(checked) })
            }
          />
        </PaletteRow>
      </PaletteSection>
    </>
  );
}

// ── Chat header ─────────────────────────────────────────────────────────

export function ChatHeaderPaletteBody() {
  const editor = useSurfaceEditor("chatHeader");
  return (
    <PaletteSection
      title="Header actions"
      description="Each appears when the project supports it."
      action={
        <PaletteResetButton
          label="Reset header actions"
          disabled={editor.isDefault}
          onClick={editor.reset}
        />
      }
    >
      <SortableElementList
        label="Header actions"
        elements={editor.elements}
        onMove={editor.move}
        onHiddenChange={editor.setHidden}
      />
    </PaletteSection>
  );
}

// ── Appearance ──────────────────────────────────────────────────────────

const APPEARANCE_MODE_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

const CHAT_WIDTH_OPTIONS = [
  { value: "comfortable", label: "Comfortable" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full" },
] as const;

const DIFF_COLOR_OPTIONS = [
  { value: "red-green", label: "Red & green" },
  { value: "blue-orange", label: "Blue & orange" },
] as const;

const ENVIRONMENT_IDENTIFICATION_OPTIONS = [
  { value: "artwork", label: "Artwork" },
  { value: "pill", label: "Pill" },
  { value: "none", label: "None" },
] as const;

interface ThemeEntry {
  readonly key: string;
  readonly card: ThemeCardDefinition;
  /** Null is the built-in T3 Code theme. */
  readonly themeId: string | null;
  readonly apply: () => void;
}

function ThemeRow({
  entry,
  pickedModes,
  resolvedAppearance,
  onPickMode,
}: {
  entry: ThemeEntry;
  pickedModes: ReadonlyArray<string>;
  resolvedAppearance: ThemeAppearance;
  onPickMode: (mode: ThemeAppearance) => void;
}) {
  const isShowing = pickedModes.includes(resolvedAppearance);
  return (
    <li className="flex h-9 items-center gap-1 rounded-lg pe-1 hover:bg-accent/40">
      <button
        type="button"
        aria-pressed={isShowing}
        onClick={entry.apply}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg ps-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1 truncate">{entry.card.label}</span>
        {isShowing ? <CheckIcon aria-hidden className="size-3.5 shrink-0 text-primary" /> : null}
      </button>
      {entry.card.previews.map((preview) => {
        const picked = pickedModes.includes(preview.mode);
        return (
          <Tooltip key={preview.mode}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`Use ${entry.card.label} for ${preview.mode} mode`}
                  aria-pressed={picked}
                  onClick={() => onPickMode(preview.mode)}
                  className={cn(
                    "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                    picked && "ring-2 ring-primary ring-offset-1 ring-offset-popover",
                  )}
                />
              }
            >
              <ThemePreviewCircle
                colors={previewColorsOf(entry.card, preview.mode) ?? preview.colors}
                mode={preview.mode}
                className="size-5.5 border"
              />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {picked ? `Shown in ${preview.mode} mode` : `Use in ${preview.mode} mode`}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </li>
  );
}

function ThemeSection() {
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
  const openThemeEditor = useThemeEditorStore((store) => store.openThemeEditor);
  const selection = useThemeSelection({
    theme,
    setTheme,
    appearanceMode,
    setAppearanceMode,
    themeHalves,
    setThemeHalf,
  });
  const definitionEntry = (definition: ThemeDefinition, key: string): ThemeEntry => ({
    key,
    card: getThemeCardDefinition(definition),
    themeId: definition.id,
    apply: () => selection.applyThemeDefinition(definition),
  });
  const entries: ThemeEntry[] = [
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
    ...environmentThemes
      .filter((definition) => !customThemes.some((custom) => custom.id === definition.id))
      .map((definition) => definitionEntry(definition, `environment:${definition.id}`)),
    ...customThemes.map((definition) => definitionEntry(definition, `custom:${definition.id}`)),
  ];
  const activeThemeId =
    (resolvedTheme === "light" ? selection.lightOwner : selection.darkOwner) ?? null;
  return (
    <PaletteSection
      title="Theme"
      action={
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            openThemeEditor({
              editingThemeId: null,
              seedThemeId: activeThemeId ? (getThemeDefinition(activeThemeId)?.id ?? null) : null,
              seedName: null,
              initialAppearance: resolvedTheme,
            })
          }
        >
          <PaintbrushIcon />
          Create
        </Button>
      }
    >
      <SegmentedControl
        label="Appearance mode"
        value={appearanceMode}
        options={APPEARANCE_MODE_OPTIONS}
        onChange={selection.setMode}
      />
      <TooltipProvider>
        <ul aria-label="Themes" className="-mx-1 max-h-56 space-y-0.5 overflow-y-auto px-1 py-0.5">
          {entries.map((entry) => (
            <ThemeRow
              key={entry.key}
              entry={entry}
              pickedModes={selection.pickedModesFor(entry.themeId)}
              resolvedAppearance={resolvedTheme}
              onPickMode={(mode) => {
                // A theme that only ships one appearance can only take that half.
                const definition = entry.themeId ? getThemeDefinition(entry.themeId) : null;
                if (definition && !getThemeModes(definition).includes(mode)) return;
                selection.handlePairPick(entry.themeId)(mode);
              }}
            />
          ))}
        </ul>
      </TooltipProvider>
    </PaletteSection>
  );
}

export function AppearancePaletteBody({ onOpenSettings }: { onOpenSettings: () => void }) {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const update = (patch: ClientSettingsPatch) => void updateSettings(patch);
  const environmentStageLabel = useEnvironmentStageLabel();
  const showEnvironmentIdentification =
    resolveEnvironmentIdentificationPillLabel(environmentStageLabel) !== null;
  const isMac = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);
  return (
    <>
      <ThemeSection />
      <PaletteSection title="Text">
        <div className="space-y-1">
          <SizeStepper
            label="Interface"
            value={settings.fontSizeInterface}
            min={MIN_INTERFACE_FONT_SIZE}
            max={MAX_INTERFACE_FONT_SIZE}
            onChange={(fontSizeInterface) => update({ fontSizeInterface })}
          />
          <SizeStepper
            label="Prompt"
            value={settings.fontSizePrompt}
            min={MIN_PROMPT_FONT_SIZE}
            max={MAX_PROMPT_FONT_SIZE}
            onChange={(fontSizePrompt) => update({ fontSizePrompt })}
          />
          <SizeStepper
            label="Code"
            value={settings.fontSizeCode}
            min={MIN_CODE_FONT_SIZE}
            max={MAX_CODE_FONT_SIZE}
            onChange={(fontSizeCode) => update({ fontSizeCode })}
          />
          <SizeStepper
            label="Terminal"
            value={settings.fontSizeTerminal}
            min={MIN_TERMINAL_FONT_SIZE}
            max={MAX_TERMINAL_FONT_SIZE}
            onChange={(fontSizeTerminal) => update({ fontSizeTerminal })}
          />
          <PaletteRow label="Wrap long lines" htmlFor="customize-word-wrap">
            <Switch
              id="customize-word-wrap"
              size="sm"
              checked={settings.wordWrap}
              onCheckedChange={(checked) => update({ wordWrap: Boolean(checked) })}
            />
          </PaletteRow>
          {isMac ? (
            <PaletteRow label="Thin text smoothing" htmlFor="customize-font-smoothing">
              <Switch
                id="customize-font-smoothing"
                size="sm"
                checked={settings.fontSmoothing}
                onCheckedChange={(checked) => update({ fontSmoothing: Boolean(checked) })}
              />
            </PaletteRow>
          ) : null}
        </div>
      </PaletteSection>
      <PaletteSection title="Chat width">
        <SegmentedControl
          label="Chat width"
          value={settings.chatWidth}
          options={CHAT_WIDTH_OPTIONS}
          onChange={(chatWidth) => update({ chatWidth })}
        />
      </PaletteSection>
      <PaletteSection title="Surfaces">
        <PaletteSlider
          label="Contrast"
          value={settings.appearanceContrast}
          min={MIN_APPEARANCE_CONTRAST}
          max={MAX_APPEARANCE_CONTRAST}
          step={5}
          unit="%"
          onChange={(appearanceContrast) => update({ appearanceContrast })}
        />
        <PaletteSlider
          label="Glass opacity"
          value={settings.glassOpacity}
          min={MIN_GLASS_OPACITY}
          max={MAX_GLASS_OPACITY}
          step={5}
          unit="%"
          onChange={(glassOpacity) => update({ glassOpacity })}
        />
        <div className="space-y-1.5">
          <span className="text-sm text-foreground">Diff colors</span>
          <SegmentedControl
            label="Diff colors"
            value={settings.diffColorScheme}
            options={DIFF_COLOR_OPTIONS}
            onChange={(diffColorScheme) => update({ diffColorScheme })}
          />
        </div>
        {showEnvironmentIdentification ? (
          <div className="space-y-1.5">
            <span className="text-sm text-foreground">Environment identification</span>
            <SegmentedControl
              label="Environment identification"
              value={settings.environmentIdentificationMode}
              options={ENVIRONMENT_IDENTIFICATION_OPTIONS}
              onChange={(environmentIdentificationMode) =>
                update({ environmentIdentificationMode })
              }
            />
          </div>
        ) : null}
      </PaletteSection>
      <PaletteSection title="Motion">
        <PaletteSlider
          label="Panel animations"
          value={settings.panelAnimationDurationMs}
          min={MIN_PANEL_ANIMATION_DURATION_MS}
          max={MAX_PANEL_ANIMATION_DURATION_MS}
          step={25}
          unit=" ms"
          onChange={(panelAnimationDurationMs) => update({ panelAnimationDurationMs })}
        />
      </PaletteSection>
      <div className="flex items-center justify-between gap-2 border-t border-border/70 pt-3">
        <span className="text-xs text-muted-foreground">Fonts, themes, and more</span>
        <Button size="xs" variant="outline" onClick={onOpenSettings}>
          Appearance settings
        </Button>
      </div>
    </>
  );
}

/** Settings each appearance control resets to, for the palette's reset button. */
export const APPEARANCE_DEFAULTS = {
  chatWidth: DEFAULT_CLIENT_SETTINGS.chatWidth,
  fontSizeInterface: DEFAULT_CLIENT_SETTINGS.fontSizeInterface,
  fontSizePrompt: DEFAULT_CLIENT_SETTINGS.fontSizePrompt,
  fontSizeCode: DEFAULT_CLIENT_SETTINGS.fontSizeCode,
  fontSizeTerminal: DEFAULT_CLIENT_SETTINGS.fontSizeTerminal,
  wordWrap: DEFAULT_CLIENT_SETTINGS.wordWrap,
  fontSmoothing: DEFAULT_CLIENT_SETTINGS.fontSmoothing,
  appearanceContrast: DEFAULT_CLIENT_SETTINGS.appearanceContrast,
  glassOpacity: DEFAULT_CLIENT_SETTINGS.glassOpacity,
  diffColorScheme: DEFAULT_CLIENT_SETTINGS.diffColorScheme,
  environmentIdentificationMode: DEFAULT_CLIENT_SETTINGS.environmentIdentificationMode,
  panelAnimationDurationMs: DEFAULT_CLIENT_SETTINGS.panelAnimationDurationMs,
} satisfies ClientSettingsPatch;
