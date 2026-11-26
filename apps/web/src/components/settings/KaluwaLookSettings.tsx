// Fork: Kaluwa's look, under Settings > Appearance on the local build. Presets are app themes, so
// they also show in the theme library and command palette; the rest is stored per device.
import type { CSSProperties } from "react";
import { useGT, useMessages } from "gt-react";
import { PaletteIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useTheme } from "../../hooks/useTheme";
import {
  KALUWA_PALETTE_MOODS,
  KALUWA_PRESETS,
  KALUWA_PRESET_IDS,
  KALUWA_STATUS_SWATCHES,
  KALUWA_SWATCH_SLOTS,
  kaluwaPalette,
  type KaluwaPreset,
} from "../../kaluwa/kaluwaPalette";
import {
  DEFAULT_KALUWA_LOOK,
  KALUWA_BADGE_STYLES,
  KALUWA_LOGO_STYLES,
  KALUWA_STATUS_COLOR_SETS,
  KALUWA_STATUS_EMPHASES,
  KALUWA_TILE_STYLES,
  setKaluwaLook,
  useKaluwaLook,
  type KaluwaLook,
} from "../../kaluwa/kaluwaLook";
import { openKaluwaThemeStudio } from "../kaluwaStudio/kaluwaStudioPanelStore";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { notifyThemeSaveFailure } from "../CommandPaletteThemeItems";
import {
  KALUWA_BADGE_LABELS,
  KALUWA_EMPHASIS_LABELS,
  KALUWA_LOGO_LABELS,
  KALUWA_MOOD_LABELS,
  KALUWA_PRESET_LABELS,
  KALUWA_STATUS_COLOR_LABELS,
  KALUWA_SWATCH_LABELS,
  KALUWA_TILE_LABELS,
} from "./kaluwaLookLabels";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

type ChoiceKey = Exclude<keyof KaluwaLook, "lift" | "statusSwatches">;

export function KaluwaPresetThumbnail({
  preset,
  scheme,
  look,
}: {
  readonly preset: KaluwaPreset;
  readonly scheme: "light" | "dark";
  readonly look: KaluwaLook;
}) {
  const colors = preset[scheme];
  const palette = kaluwaPalette(preset.id, scheme, look.mood);
  const dots = (["working", "approval", "failed", "done"] as const).map((status) => ({
    status,
    color: palette[KALUWA_STATUS_SWATCHES[status]],
  }));
  return (
    <span
      aria-hidden
      className="flex aspect-video w-full overflow-hidden rounded-md ring-1 ring-inset ring-foreground/10"
    >
      <span
        className="flex w-1/3 flex-col gap-1 border-r border-foreground/10 p-1.5"
        style={{ backgroundColor: colors.sidebar }}
      >
        {dots.map(({ status, color }) => (
          <span key={status} className="flex items-center gap-1">
            <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            <span
              className="h-1 flex-1 rounded-full opacity-25"
              style={{ backgroundColor: colors.fg }}
            />
          </span>
        ))}
      </span>
      <span
        className="flex flex-1 flex-col justify-end gap-1 p-1.5"
        style={{ backgroundColor: colors.bg }}
      >
        <span
          className="ml-auto h-2 w-1/2 rounded-sm"
          style={{ backgroundColor: colors.card, opacity: 0.9 }}
        />
        <span
          className="flex h-3 items-center justify-end rounded-sm px-0.5"
          style={{ backgroundColor: colors.composer, boxShadow: `inset 0 0 0 1px ${colors.fg}1f` }}
        >
          <span className="size-2 rounded-full" style={{ backgroundColor: colors.accent }} />
        </span>
      </span>
    </span>
  );
}

function ChoiceRow<K extends ChoiceKey>(props: {
  readonly field: K;
  readonly title: string;
  readonly description: string;
  readonly options: ReadonlyArray<KaluwaLook[K]>;
  readonly labels: Readonly<Record<KaluwaLook[K], string>>;
  readonly look: KaluwaLook;
}) {
  const gt = useGT();
  const m = useMessages();
  const value = props.look[props.field];
  const defaultValue = DEFAULT_KALUWA_LOOK[props.field];
  return (
    <SettingsRow
      title={props.title}
      description={props.description}
      resetAction={
        value !== defaultValue ? (
          <SettingResetButton
            ariaLabel={gt("Reset {setting} to default", { setting: props.title })}
            onClick={() => setKaluwaLook({ [props.field]: defaultValue } as Partial<KaluwaLook>)}
          />
        ) : null
      }
      control={
        <Select
          value={value}
          onValueChange={(next) => {
            const option = props.options.find((candidate) => candidate === next);
            if (option !== undefined)
              setKaluwaLook({ [props.field]: option } as Partial<KaluwaLook>);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={props.title}>
            <SelectValue>{m(props.labels[value])}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {props.options.map((option) => (
              <SelectItem hideIndicator key={option} value={option}>
                {option === defaultValue
                  ? gt("{option} (default)", { option: m(props.labels[option]) })
                  : m(props.labels[option])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

/** The built-in presets as cards; picking one switches the app theme. */
export function KaluwaPresetPicker(props: { readonly onPicked?: () => void }) {
  const gt = useGT();
  const m = useMessages();
  const { appearanceMode, setTheme, theme } = useTheme();
  const { look, preset: activePreset, scheme } = useKaluwaLook();
  const stockThemeActive = theme === "system" || theme === "light" || theme === "dark";

  const choosePreset = (preset: KaluwaPreset) => {
    const next = preset.themeId ?? (appearanceMode === "system" ? "system" : appearanceMode);
    if (!setTheme(next)) notifyThemeSaveFailure();
    else props.onPicked?.();
  };

  return (
    <div className="@container">
      <div
        role="radiogroup"
        aria-label={gt("Preset")}
        className="grid grid-cols-2 gap-2 @md:grid-cols-3 @2xl:grid-cols-5"
      >
        {KALUWA_PRESET_IDS.map((id) => {
          const preset = KALUWA_PRESETS[id];
          const active =
            preset.themeId === null
              ? stockThemeActive
              : activePreset.id === id && theme === preset.themeId;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => choosePreset(preset)}
              className={cn(
                "flex cursor-pointer flex-col gap-1.5 rounded-lg border p-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                active ? "border-primary" : "border-border",
              )}
            >
              <KaluwaPresetThumbnail preset={preset} scheme={scheme} look={look} />
              <span className="px-0.5 text-xs font-medium text-foreground">
                {m(KALUWA_PRESET_LABELS[id].name)}
              </span>
              <span className="px-0.5 text-2xs leading-tight text-muted-foreground">
                {m(KALUWA_PRESET_LABELS[id].blurb)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function KaluwaModeRow() {
  const gt = useGT();
  const { appearanceMode, setAppearanceMode } = useTheme();
  return (
    <SettingsRow
      title={gt("Mode")}
      description={gt("Use the preset's dark or light version, or follow the system.")}
      control={
        <Select
          value={appearanceMode}
          onValueChange={(next) => {
            if (next === "system" || next === "light" || next === "dark") {
              if (!setAppearanceMode(next)) notifyThemeSaveFailure();
            }
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={gt("Mode")}>
            <SelectValue>
              {appearanceMode === "system"
                ? gt("System")
                : appearanceMode === "light"
                  ? gt("Light")
                  : gt("Dark")}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="dark">
              {gt("Dark")}
            </SelectItem>
            <SelectItem hideIndicator value="light">
              {gt("Light")}
            </SelectItem>
            <SelectItem hideIndicator value="system">
              {gt("System")}
            </SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}

/** Palette mood, its swatches, and where status colours come from. */
export function KaluwaPaletteRows() {
  const gt = useGT();
  const m = useMessages();
  const { look, palette } = useKaluwaLook();
  return (
    <>
      <ChoiceRow
        field="mood"
        look={look}
        title={gt("Palette mood")}
        description={gt(
          "Reshape the 14 palette colors every agent, project and status color is picked from.",
        )}
        options={KALUWA_PALETTE_MOODS}
        labels={KALUWA_MOOD_LABELS}
      />
      <div className="grid grid-cols-7 gap-1.5 px-4 pb-3 sm:grid-cols-14">
        {KALUWA_SWATCH_SLOTS.map((slot) => (
          <span key={slot} className="flex min-w-0 flex-col items-center gap-1">
            <span
              aria-hidden
              className="h-5 w-full rounded-md ring-1 ring-inset ring-foreground/10"
              style={{ backgroundColor: palette[slot] }}
            />
            <span className="w-full truncate text-center text-3xs text-muted-foreground">
              {m(KALUWA_SWATCH_LABELS[slot])}
            </span>
          </span>
        ))}
      </div>

      <ChoiceRow
        field="statusColors"
        look={look}
        title={gt("Status colors")}
        description={gt("Take status colors from the palette, or keep the original bright set.")}
        options={KALUWA_STATUS_COLOR_SETS}
        labels={KALUWA_STATUS_COLOR_LABELS}
      />
      <ChoiceRow
        field="statusEmphasis"
        look={look}
        title={gt("Status emphasis")}
        description={gt(
          "Soft keeps approvals, input and failures in full color and tints the rest. Quiet colors only those. Off leaves color to the rings.",
        )}
        options={KALUWA_STATUS_EMPHASES}
        labels={KALUWA_EMPHASIS_LABELS}
      />
    </>
  );
}

/** Badge, project tile and provider logo styles. */
export function KaluwaStyleRows() {
  const gt = useGT();
  const { look } = useKaluwaLook();
  return (
    <>
      <ChoiceRow
        field="badges"
        look={look}
        title={gt("Subscription badges")}
        description={gt("How the small badge on an agent's logo shows its subscription color.")}
        options={KALUWA_BADGE_STYLES}
        labels={KALUWA_BADGE_LABELS}
      />
      <ChoiceRow
        field="tiles"
        look={look}
        title={gt("Project tiles")}
        description={gt("Tint project icons with their color, or keep them gray.")}
        options={KALUWA_TILE_STYLES}
        labels={KALUWA_TILE_LABELS}
      />
      <ChoiceRow
        field="logos"
        look={look}
        title={gt("Provider logos")}
        description={gt(
          "Softened halves the saturation of colored logos so they sit with the palette.",
        )}
        options={KALUWA_LOGO_STYLES}
        labels={KALUWA_LOGO_LABELS}
      />
    </>
  );
}

export function KaluwaLiftRow() {
  const gt = useGT();
  const { look } = useKaluwaLook();
  const liftSliderStyle = {
    "--settings-slider-progress": `${look.lift}%`,
    "--settings-slider-fill-offset": `${0.5 - look.lift / 100}rem`,
  } as CSSProperties;
  return (
    <SettingsRow
      title={gt("Lift")}
      description={gt(
        "Add a faint top highlight to raised surfaces and tint selected rows with the accent.",
      )}
      resetAction={
        look.lift !== DEFAULT_KALUWA_LOOK.lift ? (
          <SettingResetButton
            ariaLabel={gt("Reset lift to default")}
            onClick={() => setKaluwaLook({ lift: DEFAULT_KALUWA_LOOK.lift })}
          />
        ) : null
      }
      control={
        <div className="flex w-full items-center gap-3 sm:w-52">
          <output
            className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
            htmlFor="kaluwa-lift"
          >
            {look.lift}%
          </output>
          <input
            aria-label={gt("Lift")}
            className="settings-slider min-w-0 flex-1"
            id="kaluwa-lift"
            max={100}
            min={0}
            onChange={(event) => {
              const lift = Number(event.currentTarget.value);
              if (Number.isInteger(lift)) setKaluwaLook({ lift });
            }}
            step={5}
            style={liftSliderStyle}
            type="range"
            value={look.lift}
          />
        </div>
      }
    />
  );
}

export function KaluwaLookSettings() {
  const gt = useGT();
  return (
    <SettingsSection
      id="kaluwa-look"
      title={gt("Kaluwa look")}
      headerAction={
        <Button size="xs" variant="outline" onClick={() => openKaluwaThemeStudio()}>
          <PaletteIcon aria-hidden />
          {gt("Open Theme studio")}
        </Button>
      }
    >
      <div className="grid gap-3 p-4">
        <KaluwaPresetPicker />
      </div>
      <KaluwaModeRow />
      <KaluwaPaletteRows />
      <KaluwaStyleRows />
      <KaluwaLiftRow />
    </SettingsSection>
  );
}
