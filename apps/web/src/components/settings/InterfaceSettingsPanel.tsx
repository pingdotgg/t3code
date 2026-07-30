import { ContrastIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import {
  DEFAULT_CODE_FONT_SIZE_PX,
  DEFAULT_MAC_OS_FONT_SMOOTHING,
  DEFAULT_UI_FONT_SIZE_PX,
  MAX_INTERFACE_FONT_SIZE_PX,
  MIN_INTERFACE_FONT_SIZE_PX,
  applyInterfaceSettingsToDocument,
  readStoredInterfaceAppearanceSettings,
  resolveCodeFontSizePx,
  resolveMacOsFontSmoothing,
  resolveUiFontSizePx,
  writeStoredInterfaceAppearanceSettings,
  type InterfaceAppearanceSettings,
} from "../../interfaceAppearance";
import { isMacPlatform } from "../../lib/utils";
import { DEFAULT_CUSTOM_THEME_SETTINGS, type ThemeMode } from "../../theme";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { ThemePreferenceSelector } from "./ThemePreferenceSelector";

const THEME_MODE_LABELS = {
  system: "System",
  light: "Light",
  dark: "Dark",
  highContrast: "High Contrast",
} as const;

const THEME_MODE_ICONS = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
  highContrast: ContrastIcon,
} as const satisfies Record<ThemeMode, typeof MonitorIcon>;

const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark", "highContrast"];

function ThemeModeOptionLabel({ mode }: { mode: ThemeMode }) {
  const Icon = THEME_MODE_ICONS[mode];

  return (
    <span className="flex items-center gap-2">
      <Icon className="size-3.5 shrink-0 opacity-40" />
      <span className="truncate">{THEME_MODE_LABELS[mode]}</span>
    </span>
  );
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark" || value === "highContrast";
}

function parseFontSizeInput(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(MIN_INTERFACE_FONT_SIZE_PX, Math.min(MAX_INTERFACE_FONT_SIZE_PX, parsed));
}

function PixelSettingInput({
  ariaLabel,
  value,
  onCommit,
}: {
  ariaLabel: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draftValue, setDraftValue] = useState(String(value));

  useEffect(() => {
    setDraftValue(String(value));
  }, [value]);

  const commitDraft = useCallback(() => {
    const parsed = parseFontSizeInput(draftValue);
    if (parsed === null) {
      setDraftValue(String(value));
      return;
    }
    setDraftValue(String(parsed));
    if (parsed !== value) {
      onCommit(parsed);
    }
  }, [draftValue, onCommit, value]);

  return (
    <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
      <Input
        aria-label={ariaLabel}
        className="w-full sm:w-24"
        max={MAX_INTERFACE_FONT_SIZE_PX}
        min={MIN_INTERFACE_FONT_SIZE_PX}
        nativeInput
        onBlur={commitDraft}
        onChange={(event) => setDraftValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        step={1}
        type="number"
        value={draftValue}
      />
      <span className="text-ui-xs text-muted-foreground">px</span>
    </div>
  );
}

export function InterfaceSettingsPanel() {
  const { themeSettings, setThemeHue, setThemeMode, setThemeSaturation, resolvedTheme } =
    useTheme();
  const [appearance, setAppearance] = useState<InterfaceAppearanceSettings>(() =>
    readStoredInterfaceAppearanceSettings(),
  );
  const isMacOs = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);

  const updateAppearance = useCallback((next: Partial<InterfaceAppearanceSettings>) => {
    setAppearance((current) => {
      const updated = { ...current, ...next };
      writeStoredInterfaceAppearanceSettings(updated);
      applyInterfaceSettingsToDocument(updated);
      return updated;
    });
  }, []);

  const uiFontSize = resolveUiFontSizePx(appearance.uiFontScale);
  const codeFontSize = resolveCodeFontSizePx(appearance.codeFontScale);
  const macOsFontSmoothing = resolveMacOsFontSmoothing(appearance.macOsFontSmoothing);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Theme">
        <SettingsRow
          title="Theme"
          description="Build a theme from mode, hue, and saturation."
          resetAction={
            themeSettings.mode !== DEFAULT_CUSTOM_THEME_SETTINGS.mode ||
            themeSettings.hue !== DEFAULT_CUSTOM_THEME_SETTINGS.hue ||
            themeSettings.saturation !== DEFAULT_CUSTOM_THEME_SETTINGS.saturation ? (
              <SettingResetButton
                label="theme"
                onClick={() => {
                  setThemeMode(DEFAULT_CUSTOM_THEME_SETTINGS.mode);
                  setThemeHue(DEFAULT_CUSTOM_THEME_SETTINGS.hue);
                  setThemeSaturation(DEFAULT_CUSTOM_THEME_SETTINGS.saturation);
                }}
              />
            ) : null
          }
          control={
            <Select
              value={themeSettings.mode}
              onValueChange={(value) => {
                if (isThemeMode(value)) {
                  setThemeMode(value);
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="Theme mode">
                <SelectValue>{THEME_MODE_LABELS[themeSettings.mode]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {THEME_MODES.map((mode) => (
                  <SelectItem hideIndicator key={mode} value={mode}>
                    <ThemeModeOptionLabel mode={mode} />
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        >
          <ThemePreferenceSelector
            onHueChange={setThemeHue}
            onSaturationChange={setThemeSaturation}
            resolvedTheme={resolvedTheme}
            theme={themeSettings}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Typography">
        <SettingsRow
          title="UI font size"
          description="Applies directly to the app interface root size."
          resetAction={
            uiFontSize !== DEFAULT_UI_FONT_SIZE_PX ? (
              <SettingResetButton
                label="UI font size"
                onClick={() =>
                  updateAppearance({
                    uiFontScale: DEFAULT_UI_FONT_SIZE_PX,
                  })
                }
              />
            ) : null
          }
          control={
            <PixelSettingInput
              ariaLabel="UI font size"
              onCommit={(value) => updateAppearance({ uiFontScale: value })}
              value={uiFontSize}
            />
          }
        />

        <SettingsRow
          title="Code font size"
          description="Applies to the diff editor, terminal, and read-only code surfaces."
          resetAction={
            codeFontSize !== DEFAULT_CODE_FONT_SIZE_PX ? (
              <SettingResetButton
                label="code font size"
                onClick={() =>
                  updateAppearance({
                    codeFontScale: DEFAULT_CODE_FONT_SIZE_PX,
                  })
                }
              />
            ) : null
          }
          control={
            <PixelSettingInput
              ariaLabel="Code font size"
              onCommit={(value) => updateAppearance({ codeFontScale: value })}
              value={codeFontSize}
            />
          }
        />

        {isMacOs ? (
          <SettingsRow
            title="Font smoothing"
            description="macOS only. Toggle grayscale text smoothing."
            resetAction={
              macOsFontSmoothing !== DEFAULT_MAC_OS_FONT_SMOOTHING ? (
                <SettingResetButton
                  label="font smoothing"
                  onClick={() =>
                    updateAppearance({
                      macOsFontSmoothing: DEFAULT_MAC_OS_FONT_SMOOTHING,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                aria-label="Font smoothing"
                checked={macOsFontSmoothing === "grayscale"}
                onCheckedChange={(checked) =>
                  updateAppearance({ macOsFontSmoothing: checked ? "grayscale" : "auto" })
                }
              />
            }
          />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
