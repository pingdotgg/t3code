import { isElectron } from "../../env";
import { isMacPlatform } from "../../lib/utils";
import { RestoreDeviceDefaultsButton } from "./SettingsPanels";
import type { CSSProperties } from "react";
import { useState } from "react";
import { msg, useGT, useMessages } from "gt-react";
import {
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
  DEFAULT_UNIFIED_SETTINGS,
  type ChatWidth,
  type EffortDisplay,
  type EnvironmentIdentificationMode,
  MAX_APPEARANCE_CONTRAST,
  MAX_PANEL_ANIMATION_DURATION_MS,
  MIN_APPEARANCE_CONTRAST,
  MIN_PANEL_ANIMATION_DURATION_MS,
} from "@t3tools/contracts/settings";
import {
  resolveSidebarStageBackdropVariant,
  type SidebarStageBackdropVariant,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ThemeLibrary } from "./ThemeSettings";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsSearchTarget,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { AppIconRow } from "./AppIconSettings";
import { PanelAnimationsPreview } from "./PanelAnimationsPreview";
import { TypographySection } from "./TypographySettings";
import { ThreadDetailsItemsRow } from "./ThreadDetailsItemsRow";
import { SurfaceStylePicker } from "./SurfaceStylePreview";

const ENVIRONMENT_IDENTIFICATION_LABELS: Record<EnvironmentIdentificationMode, string> = {
  artwork: msg("Artwork"),
  "nightly-artwork": msg("Nightly artwork"),
  "dev-artwork": msg("Dev artwork"),
  pill: msg("Version pill"),
  none: msg("None"),
};

// The default "artwork" follows the running channel, so it is labeled as that channel's art,
// or as "None" on Latest. The other channel's art is offered as a fixed choice.
function environmentIdentificationOptions(
  stageVariant: SidebarStageBackdropVariant | null,
): ReadonlyArray<readonly [EnvironmentIdentificationMode, string]> {
  if (stageVariant === "dev") {
    return [
      ["artwork", msg("Dev artwork")],
      ["nightly-artwork", msg("Nightly artwork")],
      ["pill", msg("Version pill")],
      ["none", msg("None")],
    ];
  }
  if (stageVariant === "nightly") {
    return [
      ["artwork", msg("Nightly artwork")],
      ["dev-artwork", msg("Dev artwork")],
      ["pill", msg("Version pill")],
      ["none", msg("None")],
    ];
  }
  return [
    ["artwork", msg("None")],
    ["nightly-artwork", msg("Nightly artwork")],
    ["dev-artwork", msg("Dev artwork")],
  ];
}

const CHAT_WIDTH_LABELS: Record<ChatWidth, string> = {
  comfortable: msg("Comfortable"),
  wide: msg("Wide"),
  full: msg("Full", { $context: "chat width" }),
};

const EFFORT_DISPLAY_LABELS: Record<EffortDisplay, string> = {
  label: msg("Word", { $context: "show effort as a word" }),
  bars: msg("Bars", { $context: "show effort as bars" }),
};

export function AppearanceSettingsPanel() {
  const searchableSetting = useSearchableSetting();
  const {
    appearanceMode,
    refreshTheme,
    resolvedTheme,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
    appearanceChoice,
    setAppearanceChoice,
  } = useTheme();
  const gt = useGT();
  const m = useMessages();
  const customThemes = useCustomThemes();
  const [isImportThemeOpen, setIsImportThemeOpen] = useState(false);
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const environmentStageLabel = useEnvironmentStageLabel();
  const environmentStageVariant = resolveSidebarStageBackdropVariant(environmentStageLabel);
  const environmentIdentificationOptionList =
    environmentIdentificationOptions(environmentStageVariant);
  const environmentIdentificationLabel = m(
    environmentIdentificationOptionList.find(
      ([value]) => value === settings.environmentIdentificationMode,
    )?.[1] ?? ENVIRONMENT_IDENTIFICATION_LABELS[settings.environmentIdentificationMode],
  );
  const effectiveEnvironmentIdentificationMode = useEnvironmentIdentificationMode();
  const themeHidesEnvironmentArtwork =
    effectiveEnvironmentIdentificationMode === "pill" &&
    resolveSidebarStageBackdropVariant(
      environmentStageLabel,
      settings.environmentIdentificationMode,
    ) !== null;
  const environmentIdentificationDescription = themeHidesEnvironmentArtwork
    ? environmentStageVariant
      ? gt("Only built-in themes show artwork, so this theme shows the version pill.")
      : gt("Only built-in themes show artwork.")
    : environmentStageVariant
      ? gt("Choose how Dev and Nightly environments are identified.")
      : gt("Show Dev or Nightly artwork in the sidebar header.");
  const appearanceContrastRatio =
    (settings.appearanceContrast - MIN_APPEARANCE_CONTRAST) /
    (MAX_APPEARANCE_CONTRAST - MIN_APPEARANCE_CONTRAST);
  const appearanceContrastSliderStyle = {
    "--settings-slider-progress": `${appearanceContrastRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - appearanceContrastRatio}rem`,
  } as CSSProperties;
  const panelAnimationDurationRatio =
    (settings.panelAnimationDurationMs - MIN_PANEL_ANIMATION_DURATION_MS) /
    (MAX_PANEL_ANIMATION_DURATION_MS - MIN_PANEL_ANIMATION_DURATION_MS);
  const panelAnimationDurationSliderStyle = {
    "--settings-slider-progress": `${panelAnimationDurationRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - panelAnimationDurationRatio}rem`,
  } as CSSProperties;

  return (
    <SettingsPageContainer>
      <SettingsSection id="appearance" title={gt("Colors & themes")} variant="plain" hideTitle>
        <div id={searchableSetting("theme").id}>
          <ThemeLibrary
            appearanceMode={appearanceMode}
            customThemes={customThemes}
            initialAppearance={resolvedTheme}
            refreshTheme={refreshTheme}
            isImportOpen={isImportThemeOpen}
            setTheme={setTheme}
            setThemeHalf={setThemeHalf}
            theme={theme}
            themeHalves={themeHalves}
            appearanceChoice={appearanceChoice}
            setAppearanceChoice={setAppearanceChoice}
            restoreAction={<RestoreDeviceDefaultsButton />}
            onImportOpenChange={setIsImportThemeOpen}
          />
        </div>
      </SettingsSection>

      <SettingsSection id="appearance-style" title={gt("Style", { $context: "settings section, surface style" })} variant="plain" hideTitle>
        <SettingsSearchTarget className="space-y-2.5" id={searchableSetting("surface-style").id}>
          <div className="flex min-h-7 items-center">
            <h3 className="text-title text-dim-foreground">
              {searchableSetting("surface-style").title}
            </h3>
          </div>
          <SurfaceStylePicker
            value={settings.surfaceStyle}
            defaultValue={DEFAULT_UNIFIED_SETTINGS.surfaceStyle}
            onChange={(surfaceStyle) => updateSettings({ surfaceStyle })}
          />
        </SettingsSearchTarget>
      </SettingsSection>

      <SettingsSection id="appearance-interface" title={gt("Interface")}>
        <SettingsRow
          {...searchableSetting("setting-appearance-contrast")}
          description={gt("Adjust the contrast of colors and borders across the interface.")}
          resetAction={
            settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast ? (
              <SettingResetButton
                ariaLabel={gt("Reset contrast to default")}
                onClick={() =>
                  updateSettings({
                    appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-2.5 sm:w-52">
              <input
                aria-label={gt("Contrast")}
                className="settings-slider min-w-0 flex-1"
                id="appearance-contrast"
                max={MAX_APPEARANCE_CONTRAST}
                min={MIN_APPEARANCE_CONTRAST}
                onChange={(event) => {
                  const appearanceContrast = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(appearanceContrast) &&
                    appearanceContrast >= MIN_APPEARANCE_CONTRAST &&
                    appearanceContrast <= MAX_APPEARANCE_CONTRAST
                  ) {
                    updateSettings({ appearanceContrast });
                  }
                }}
                step={5}
                style={appearanceContrastSliderStyle}
                type="range"
                value={settings.appearanceContrast}
              />
              <output
                className="min-w-12 text-right text-caption tabular-nums text-muted-foreground"
                htmlFor="appearance-contrast"
              >
                {settings.appearanceContrast === DEFAULT_UNIFIED_SETTINGS.appearanceContrast
                  ? gt("Normal", { $context: "default contrast level" })
                  : `${settings.appearanceContrast}%`}
              </output>
            </div>
          }
        />

        {isElectron && isMacPlatform(navigator.platform) ? (
          <SettingsRow
            {...searchableSetting("hide-window-controls")}
            description={gt("They come back when you expand the sidebar.")}
            control={
              <Switch
                checked={settings.hideWindowControlsWhenSidebarCollapsed}
                onCheckedChange={(checked) =>
                  updateSettings({ hideWindowControlsWhenSidebarCollapsed: Boolean(checked) })
                }
                aria-label={gt("Hide window controls when the sidebar is collapsed")}
              />
            }
          />
        ) : null}

        <SettingsRow
          {...searchableSetting("chat-width")}
          description={gt("Set how wide messages and the composer can grow on large screens.")}
          resetAction={
            settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? (
              <SettingResetButton
                ariaLabel={gt("Reset chat width to default")}
                onClick={() => updateSettings({ chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth })}
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={settings.chatWidth}
                onValueChange={(value) => {
                  if (value === "comfortable" || value === "wide" || value === "full")
                    updateSettings({ chatWidth: value });
                }}
              >
                <SelectTrigger
                  variant="well"
                  size="compact"
                  className="w-full min-w-0"
                  aria-label={gt("Chat width")}
                >
                  <SelectValue>{m(CHAT_WIDTH_LABELS[settings.chatWidth])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="comfortable">{gt("Comfortable (default)")}</SelectItem>
                  <SelectItem value="wide">{m(CHAT_WIDTH_LABELS.wide)}</SelectItem>
                  <SelectItem value="full">{m(CHAT_WIDTH_LABELS.full)}</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />
        <ThreadDetailsItemsRow />
        <SettingsRow
          {...searchableSetting("effort-display")}
          description={gt(
            "Show reasoning effort in the composer as its name, such as High, or as bars.",
          )}
          resetAction={
            settings.effortDisplay !== DEFAULT_UNIFIED_SETTINGS.effortDisplay ? (
              <SettingResetButton
                ariaLabel={gt("Reset effort display to default")}
                onClick={() =>
                  updateSettings({ effortDisplay: DEFAULT_UNIFIED_SETTINGS.effortDisplay })
                }
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={settings.effortDisplay}
                onValueChange={(value) => {
                  if (value === "bars" || value === "label")
                    updateSettings({ effortDisplay: value });
                }}
              >
                <SelectTrigger
                  variant="well"
                  size="compact"
                  className="w-full min-w-0"
                  aria-label={gt("Effort display")}
                >
                  <SelectValue>{m(EFFORT_DISPLAY_LABELS[settings.effortDisplay])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="label">{gt("Word (default)")}</SelectItem>
                  <SelectItem value="bars">{m(EFFORT_DISPLAY_LABELS.bars)}</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("math-rendering")}
          description={gt(
            "Typeset LaTeX math, such as $x^2$ or \\[x^2\\], in messages and Markdown previews. The composer keeps TeX source editable.",
          )}
          resetAction={
            settings.mathRenderingEnabled !== DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled ? (
              <SettingResetButton
                ariaLabel={gt("Reset math rendering to default")}
                onClick={() =>
                  updateSettings({
                    mathRenderingEnabled: DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.mathRenderingEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ mathRenderingEnabled: Boolean(checked) })
              }
              aria-label={gt("Render math")}
            />
          }
        />
        <AppIconRow />
        <SettingsRow
          {...searchableSetting("environment-identification")}
          description={environmentIdentificationDescription}
          resetAction={
            settings.environmentIdentificationMode !== DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE ? (
              <SettingResetButton
                ariaLabel={gt("Reset environment identification to default")}
                onClick={() => {
                  updateSettings({
                    environmentIdentificationMode: DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
                  });
                }}
              />
            ) : null
          }
          control={
            <Select
              value={settings.environmentIdentificationMode}
              onValueChange={(value) => {
                const option = environmentIdentificationOptionList.find(
                  ([optionValue]) => optionValue === value,
                );
                if (option) {
                  updateSettings({ environmentIdentificationMode: option[0] });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label={gt("Environment identification")}
              >
                <SelectValue>{environmentIdentificationLabel}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {environmentIdentificationOptionList.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {m(label)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection id="appearance-motion" title={gt("Motion")}>
        <SettingsRow
          {...searchableSetting("panel-animations")}
          description={gt("Set how fast panels open and close.")}
          control={
            <div className="grid w-full grid-cols-1 items-center gap-3 sm:w-auto sm:grid-cols-[7rem_13rem] sm:gap-4">
              <PanelAnimationsPreview durationMs={settings.panelAnimationDurationMs} />
              <div className="flex w-full items-center gap-3">
                <output
                  className="min-w-16 rounded-control surface-card px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                  htmlFor="panel-animation-duration"
                >
                  {settings.panelAnimationDurationMs} ms
                </output>
                <input
                  aria-label={gt("Panel animation duration")}
                  className="settings-slider min-w-0 flex-1"
                  id="panel-animation-duration"
                  max={MAX_PANEL_ANIMATION_DURATION_MS}
                  min={MIN_PANEL_ANIMATION_DURATION_MS}
                  onChange={(event) => {
                    const panelAnimationDurationMs = Number(event.currentTarget.value);
                    if (
                      Number.isInteger(panelAnimationDurationMs) &&
                      panelAnimationDurationMs >= MIN_PANEL_ANIMATION_DURATION_MS &&
                      panelAnimationDurationMs <= MAX_PANEL_ANIMATION_DURATION_MS
                    ) {
                      updateSettings({ panelAnimationDurationMs });
                    }
                  }}
                  step={25}
                  style={panelAnimationDurationSliderStyle}
                  type="range"
                  value={settings.panelAnimationDurationMs}
                />
              </div>
            </div>
          }
          resetAction={
            settings.panelAnimationDurationMs !==
            DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs ? (
              <SettingResetButton
                ariaLabel={gt("Reset panel animations to default")}
                onClick={() =>
                  updateSettings({
                    panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
                  })
                }
              />
            ) : null
          }
        />
      </SettingsSection>

      <TypographySection />
    </SettingsPageContainer>
  );
}
