import {
  type AppWallpaper,
  DEFAULT_UNIFIED_SETTINGS,
  MAX_WALLPAPER_BLUR,
  MAX_WALLPAPER_DIM,
} from "@t3tools/contracts/settings";
import type { CSSProperties } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const WALLPAPER_LABELS: Record<AppWallpaper, string> = {
  none: "None",
  "f1-race": "F1 race",
};

function sliderStyle(value: number, max: number): CSSProperties {
  const ratio = value / max;
  return {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
}

function WallpaperSlider(props: {
  id: "wallpaper-blur" | "wallpaper-dim";
  label: string;
  value: number;
  max: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex w-full items-center gap-3 sm:w-52">
      <output
        className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
        htmlFor={props.id}
      >
        {props.value}
        {props.unit}
      </output>
      <input
        aria-label={props.label}
        className="settings-slider min-w-0 flex-1"
        id={props.id}
        max={props.max}
        min={0}
        onChange={(event) => {
          const value = Number(event.currentTarget.value);
          if (Number.isInteger(value) && value >= 0 && value <= props.max) props.onChange(value);
        }}
        step={1}
        style={sliderStyle(props.value, props.max)}
        type="range"
        value={props.value}
      />
    </div>
  );
}

/** Picks a picture behind the app, and how much it is blurred and darkened so text stays readable. */
export function WallpaperSettingsRows() {
  const wallpaper = useClientSettings((settings) => settings.wallpaper);
  const blur = useClientSettings((settings) => settings.wallpaperBlur);
  const dim = useClientSettings((settings) => settings.wallpaperDim);
  return (
    <>
      <SettingsRow
        {...searchableSetting("wallpaper")}
        devicePreference
        description="Show a picture behind the sidebar and chat."
        resetAction={
          wallpaper !== DEFAULT_UNIFIED_SETTINGS.wallpaper ? (
            <SettingResetButton
              label="wallpaper"
              onClick={() =>
                updateClientSettings({ wallpaper: DEFAULT_UNIFIED_SETTINGS.wallpaper })
              }
            />
          ) : null
        }
        control={
          <div className="w-full sm:w-52">
            <Select
              value={wallpaper}
              onValueChange={(value) => {
                if (value === "none" || value === "f1-race") {
                  updateClientSettings({ wallpaper: value });
                }
              }}
            >
              <SelectTrigger size="sm" aria-label="Wallpaper">
                <SelectValue>{WALLPAPER_LABELS[wallpaper]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="none">{WALLPAPER_LABELS.none}</SelectItem>
                <SelectItem value="f1-race">{WALLPAPER_LABELS["f1-race"]}</SelectItem>
              </SelectPopup>
            </Select>
          </div>
        }
      />
      {wallpaper === "none" ? null : (
        <>
          <SettingsRow
            {...searchableSetting("setting-wallpaper-blur")}
            devicePreference
            description="Blur the wallpaper so text in front of it is easier to read."
            resetAction={
              blur !== DEFAULT_UNIFIED_SETTINGS.wallpaperBlur ? (
                <SettingResetButton
                  label="wallpaper blur"
                  onClick={() =>
                    updateClientSettings({ wallpaperBlur: DEFAULT_UNIFIED_SETTINGS.wallpaperBlur })
                  }
                />
              ) : null
            }
            control={
              <WallpaperSlider
                id="wallpaper-blur"
                label="Wallpaper blur"
                value={blur}
                max={MAX_WALLPAPER_BLUR}
                unit="px"
                onChange={(wallpaperBlur) => updateClientSettings({ wallpaperBlur })}
              />
            }
          />
          <SettingsRow
            {...searchableSetting("setting-wallpaper-dim")}
            devicePreference
            description="Darken the wallpaper toward the theme's background."
            resetAction={
              dim !== DEFAULT_UNIFIED_SETTINGS.wallpaperDim ? (
                <SettingResetButton
                  label="wallpaper dimming"
                  onClick={() =>
                    updateClientSettings({ wallpaperDim: DEFAULT_UNIFIED_SETTINGS.wallpaperDim })
                  }
                />
              ) : null
            }
            control={
              <WallpaperSlider
                id="wallpaper-dim"
                label="Wallpaper dimming"
                value={dim}
                max={MAX_WALLPAPER_DIM}
                unit="%"
                onChange={(wallpaperDim) => updateClientSettings({ wallpaperDim })}
              />
            }
          />
        </>
      )}
    </>
  );
}
