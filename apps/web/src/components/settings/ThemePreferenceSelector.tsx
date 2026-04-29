import type { CustomThemeSettings } from "../../theme";
import { SettingsRow } from "./settingsLayout";
import { Slider } from "../ui/slider";

function clampHue(value: number): number {
  const normalized = Math.round(value) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function clampSaturation(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function ThemeColorPreview({ color }: { color: string }) {
  return (
    <div className="inline-flex items-center">
      <span
        aria-hidden
        className="size-3 rounded-full border border-black/8 shadow-sm"
        style={{ background: color }}
      />
    </div>
  );
}

export function ThemePreferenceSelector({
  theme,
  resolvedTheme,
  onHueChange,
  onSaturationChange,
}: {
  theme: CustomThemeSettings;
  resolvedTheme: "light" | "dark";
  onHueChange: (hue: number) => void;
  onSaturationChange: (saturation: number) => void;
}) {
  const huePreview = `hsl(${theme.hue} 100% ${resolvedTheme === "dark" ? "62%" : "50%"})`;
  const saturationPreview = `hsl(${theme.hue} ${theme.saturation}% ${
    resolvedTheme === "dark" ? "62%" : "50%"
  })`;

  return (
    <>
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            <span>Hue</span>
            <ThemeColorPreview color={huePreview} />
          </span>
        }
        description="Pick the base color family for the interface."
        control={
          <div className="w-full sm:w-[28rem]">
            <Slider
              aria-label="Theme hue"
              fill="color-mix(in srgb, var(--foreground) 16%, var(--primary))"
              max={359}
              min={0}
              onChange={(value) => onHueChange(clampHue(value))}
              value={theme.hue}
              valueLabel={`${theme.hue}\u00b0`}
            />
          </div>
        }
      />

      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            <span>Saturation</span>
            <ThemeColorPreview color={saturationPreview} />
          </span>
        }
        description="Lower values neutralize the palette. Higher values make accents bolder."
        control={
          <div className="w-full sm:w-[28rem]">
            <Slider
              aria-label="Theme saturation"
              fill={`hsl(${theme.hue} ${Math.max(theme.saturation, 16)}% ${
                resolvedTheme === "dark" ? "64%" : "54%"
              }%)`}
              max={100}
              min={0}
              onChange={(value) => onSaturationChange(clampSaturation(value))}
              value={theme.saturation}
              valueLabel={`${theme.saturation}%`}
            />
          </div>
        }
      />
    </>
  );
}
