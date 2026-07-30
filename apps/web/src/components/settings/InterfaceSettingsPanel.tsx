import { DEFAULT_APP_ICON_ID, type AppIconId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import {
  IconCircleLefthalfFilledRighthalfStripedHorizontalInverse as ContrastIcon,
  IconDisplay as DisplayIcon,
  IconMoonFill as MoonIcon,
  IconSunMaxFill as SunIcon,
} from "symbols-react";
import { useCallback, useEffect, useState } from "react";

import { APP_ICON_OPTIONS } from "../../appIcon";
import {
  useClientSettings,
  usePrimarySettings,
  useUpdateClientSettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
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
import { cn, isMacPlatform } from "../../lib/utils";
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

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const THEME_MODE_ICONS = {
  system: DisplayIcon,
  light: SunIcon,
  dark: MoonIcon,
  highContrast: ContrastIcon,
} as const satisfies Record<ThemeMode, typeof DisplayIcon>;

const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark", "highContrast"];

function ThemeModeOptionLabel({ mode }: { mode: ThemeMode }) {
  const Icon = THEME_MODE_ICONS[mode];

  return (
    <span className="flex items-center gap-2">
      <Icon className="size-3.5 shrink-0 fill-current opacity-40" />
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

function AppIconPreview({ id, src }: { id: AppIconId; src: string }) {
  const [failed, setFailed] = useState(false);
  const initials = id
    .replace("forma-", "")
    .split("-")
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 2);

  return (
    <span className="relative flex size-16 items-center justify-center overflow-hidden rounded-[22%]">
      {!failed ? (
        <img
          alt=""
          className="size-full object-cover"
          draggable={false}
          onError={() => setFailed(true)}
          src={src}
        />
      ) : (
        <span className="text-ui-xs font-semibold text-muted-foreground">{initials}</span>
      )}
    </span>
  );
}

function AppIconPicker({
  value,
  onChange,
}: {
  value: AppIconId;
  onChange: (value: AppIconId) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 pt-4 pb-5 sm:grid-cols-5">
      {APP_ICON_OPTIONS.map((option) => {
        const selected = option.id === value;
        return (
          <button
            aria-pressed={selected}
            className={cn(
              "group flex min-h-0 flex-col items-center justify-center gap-2 rounded-xl border px-2 py-3 text-center transition-colors",
              selected
                ? "border-foreground/55 bg-foreground/[0.04] text-foreground"
                : "border-border/70 bg-background/40 text-muted-foreground hover:border-foreground/25 hover:bg-muted/50 hover:text-foreground",
            )}
            key={option.id}
            onClick={() => onChange(option.id)}
            type="button"
          >
            <AppIconPreview id={option.id} src={option.previewSrc} />
            <span className="text-xs leading-tight font-medium">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function InterfaceSettingsPanel() {
  const { themeSettings, setThemeHue, setThemeMode, setThemeSaturation, resolvedTheme } =
    useTheme();
  const [appearance, setAppearance] = useState<InterfaceAppearanceSettings>(() =>
    readStoredInterfaceAppearanceSettings(),
  );
  const appIcon = useClientSettings((settings) => settings.appIcon);
  const updateClientSettings = useUpdateClientSettings();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
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

      <SettingsSection title="Icons">
        <SettingsRow
          description="Choose the artwork used for browser chrome and the desktop dock or window icon."
          resetAction={
            appIcon !== DEFAULT_APP_ICON_ID ? (
              <SettingResetButton
                label="app icon"
                onClick={() => updateClientSettings({ appIcon: DEFAULT_APP_ICON_ID })}
              />
            ) : null
          }
          title="App icon"
        >
          <AppIconPicker
            onChange={(nextAppIcon) => updateClientSettings({ appIcon: nextAppIcon })}
            value={appIcon}
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

      <SettingsSection title="Display">
        <SettingsRow
          title="Time format"
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Timestamp format">
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Word wrap"
          description="Wrap long lines in code blocks, tables, diffs, and file previews by default."
          resetAction={
            settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? (
              <SettingResetButton
                label="word wrapping"
                onClick={() =>
                  updateSettings({
                    wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.wordWrap}
              onCheckedChange={(checked) => updateSettings({ wordWrap: Boolean(checked) })}
              aria-label="Wrap code, tables, diffs, and file previews by default"
            />
          }
        />

        <SettingsRow
          title="Assistant output"
          description="Show token-by-token output while a response is in progress."
          resetAction={
            settings.enableAssistantStreaming !==
            DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
              <SettingResetButton
                label="assistant output"
                onClick={() =>
                  updateSettings({
                    enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableAssistantStreaming}
              onCheckedChange={(checked) =>
                updateSettings({ enableAssistantStreaming: Boolean(checked) })
              }
              aria-label="Stream assistant messages"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
