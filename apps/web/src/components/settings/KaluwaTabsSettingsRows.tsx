// Fork: the rows that set up Kaluwa's titlebar tabs: on or off, style, radius and height. A
// component of its own so other settings pages can show the same controls.
import { useGT } from "gt-react";
import type { CSSProperties } from "react";

import {
  DEFAULT_KALUWA_TABS_SETTINGS,
  KALUWA_TAB_HEIGHT_LIMITS,
  KALUWA_TAB_RADIUS_LIMITS,
  KALUWA_TAB_STYLES,
  resetKaluwaTabsSettings,
  updateKaluwaTabsSettings,
  useKaluwaTabsSettings,
  type KaluwaTabsSettings,
  type KaluwaTabStyle,
} from "../../kaluwa/kaluwaTabsSettings";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

function ResetAction({
  field,
  title,
  settings,
}: {
  readonly field: keyof KaluwaTabsSettings;
  readonly title: string;
  readonly settings: KaluwaTabsSettings;
}) {
  const gt = useGT();
  if (settings[field] === DEFAULT_KALUWA_TABS_SETTINGS[field]) return null;
  return (
    <SettingResetButton
      ariaLabel={gt("Reset {setting} to default", { setting: title })}
      onClick={() => resetKaluwaTabsSettings([field])}
    />
  );
}

function PixelSliderRow({
  field,
  title,
  description,
  limits: [min, max],
  settings,
}: {
  readonly field: "radius" | "height";
  readonly title: string;
  readonly description: string;
  readonly limits: readonly [number, number];
  readonly settings: KaluwaTabsSettings;
}) {
  const value = settings[field];
  const ratio = (value - min) / (max - min);
  const style = {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
  return (
    <SettingsRow
      devicePreference
      title={title}
      description={description}
      resetAction={<ResetAction field={field} title={title} settings={settings} />}
      control={
        <div className="flex w-full items-center gap-3 sm:w-52">
          <output className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground">
            {value}px
          </output>
          <input
            aria-label={title}
            className="settings-slider min-w-0 flex-1"
            type="range"
            min={min}
            max={max}
            step={1}
            value={value}
            style={style}
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              if (Number.isInteger(next)) updateKaluwaTabsSettings({ [field]: next });
            }}
          />
        </div>
      }
    />
  );
}

export function KaluwaTabsSettingsRows() {
  const gt = useGT();
  const settings = useKaluwaTabsSettings();
  const styleLabels: Record<KaluwaTabStyle, string> = {
    pill: gt("Pill", { $context: "tab style: rounded pill tabs" }),
    folder: gt("Attached", { $context: "tab style: folder tabs attached to the page" }),
    line: gt("Underline", { $context: "tab style: underlined tabs" }),
  };
  const enabledTitle = gt("Titlebar tabs");
  const styleTitle = gt("Tab style");
  return (
    <>
      <SettingsRow
        devicePreference
        title={enabledTitle}
        description={gt(
          "Show open threads as tabs in the titlebar. A sidebar click opens a thread in the current tab; the + button or a middle-click opens a new one.",
        )}
        resetAction={<ResetAction field="enabled" title={enabledTitle} settings={settings} />}
        control={
          <Switch
            checked={settings.enabled}
            onCheckedChange={(checked) => updateKaluwaTabsSettings({ enabled: Boolean(checked) })}
            aria-label={enabledTitle}
          />
        }
      />
      <SettingsRow
        devicePreference
        title={styleTitle}
        description={gt(
          "Pill raises the active tab, Attached joins it to the page like a folder tab, Underline marks it with the accent.",
        )}
        resetAction={<ResetAction field="style" title={styleTitle} settings={settings} />}
        control={
          <ToggleGroup
            aria-label={styleTitle}
            variant="segmented"
            value={[settings.style]}
            onValueChange={(next) => {
              const style = KALUWA_TAB_STYLES.find((option) => option === next[0]);
              if (style) updateKaluwaTabsSettings({ style });
            }}
          >
            {KALUWA_TAB_STYLES.map((style) => (
              <Toggle key={style} value={style}>
                {styleLabels[style]}
              </Toggle>
            ))}
          </ToggleGroup>
        }
      />
      <PixelSliderRow
        field="radius"
        title={gt("Tab radius")}
        description={gt("Corner rounding, capped at half the tab height.")}
        limits={KALUWA_TAB_RADIUS_LIMITS}
        settings={settings}
      />
      <PixelSliderRow
        field="height"
        title={gt("Tab height")}
        description={gt("Height of each tab. Underline tabs always fill the titlebar.")}
        limits={KALUWA_TAB_HEIGHT_LIMITS}
        settings={settings}
      />
    </>
  );
}
