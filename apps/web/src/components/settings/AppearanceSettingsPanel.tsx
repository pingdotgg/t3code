import type { CSSProperties } from "react";
import { useState } from "react";
import {
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
  DEFAULT_UNIFIED_SETTINGS,
  type ChatWidth,
  type EffortDisplay,
  type EnvironmentIdentificationMode,
  MAX_APPEARANCE_CONTRAST,
  MAX_GLASS_OPACITY,
  MAX_PANEL_ANIMATION_DURATION_MS,
  MIN_APPEARANCE_CONTRAST,
  MIN_GLASS_OPACITY,
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
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { AdvancedSettings } from "./AdvancedSettings";
import { PanelAnimationsPreview } from "./PanelAnimationsPreview";
import { TypographySection } from "./TypographySettings";
import { ThreadDetailsItemsRow } from "./ThreadDetailsItemsRow";
import { UiLocaleSettingsRow } from "./UiLocaleSettingsRow";
import { useTranslation } from "react-i18next";

const ENVIRONMENT_IDENTIFICATION_LABELS = {
  artwork: "appearance.envArtwork",
  "nightly-artwork": "appearance.envNightlyArtwork",
  "dev-artwork": "appearance.envDevArtwork",
  pill: "appearance.envVersionPill",
  none: "appearance.envNone",
} as const satisfies Record<EnvironmentIdentificationMode, string>;

// The default "artwork" follows the running channel, so it is labeled as that channel's art,
// or as "None" on Latest. The other channel's art is offered as a fixed choice.
type EnvironmentIdentificationOption = readonly [
  EnvironmentIdentificationMode,
  (typeof ENVIRONMENT_IDENTIFICATION_LABELS)[EnvironmentIdentificationMode],
];

function environmentIdentificationOptions(
  stageVariant: SidebarStageBackdropVariant | null,
): ReadonlyArray<EnvironmentIdentificationOption> {
  if (stageVariant === "dev") {
    return [
      ["artwork", "appearance.envDevArtwork"],
      ["nightly-artwork", "appearance.envNightlyArtwork"],
      ["pill", "appearance.envVersionPill"],
      ["none", "appearance.envNone"],
    ];
  }
  if (stageVariant === "nightly") {
    return [
      ["artwork", "appearance.envNightlyArtwork"],
      ["dev-artwork", "appearance.envDevArtwork"],
      ["pill", "appearance.envVersionPill"],
      ["none", "appearance.envNone"],
    ];
  }
  return [
    ["artwork", "appearance.envNone"],
    ["nightly-artwork", "appearance.envNightlyArtwork"],
    ["dev-artwork", "appearance.envDevArtwork"],
  ];
}

const CHAT_WIDTH_LABELS = {
  comfortable: "appearance.chatWidthComfortable",
  wide: "appearance.chatWidthWide",
  full: "appearance.chatWidthFull",
} as const satisfies Record<ChatWidth, string>;

const EFFORT_DISPLAY_LABELS = {
  label: "appearance.effortWord",
  bars: "appearance.effortBars",
} as const satisfies Record<EffortDisplay, string>;

export function AppearanceSettingsPanel() {
  const { t } = useTranslation("settings");
  const {
    appearanceMode,
    refreshTheme,
    resolvedTheme,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
  } = useTheme();
  const customThemes = useCustomThemes();
  const [isImportThemeOpen, setIsImportThemeOpen] = useState(false);
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const environmentStageLabel = useEnvironmentStageLabel();
  const environmentStageVariant = resolveSidebarStageBackdropVariant(environmentStageLabel);
  const environmentIdentificationOptionList =
    environmentIdentificationOptions(environmentStageVariant);
  const environmentIdentificationLabel = t(
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
      ? t("appearance.envPillBecauseCustomTheme")
      : t("appearance.envBuiltInOnly")
    : environmentStageVariant
      ? t("appearance.envChooseHow")
      : t("appearance.envShowInSidebar");
  const glassOpacityRatio =
    (settings.glassOpacity - MIN_GLASS_OPACITY) / (MAX_GLASS_OPACITY - MIN_GLASS_OPACITY);
  const glassOpacitySliderStyle = {
    "--settings-slider-progress": `${glassOpacityRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - glassOpacityRatio}rem`,
  } as CSSProperties;
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
      <SettingsSection
        id="appearance"
        title={t("appearance.colorsAndThemes")}
        variant="plain"
        hideTitle
      >
        <div id={searchableSetting("theme").id}>
          <ThemeLibrary
            appearanceMode={appearanceMode}
            customThemes={customThemes}
            initialAppearance={resolvedTheme}
            refreshTheme={refreshTheme}
            isImportOpen={isImportThemeOpen}
            setAppearanceMode={setAppearanceMode}
            setTheme={setTheme}
            setThemeHalf={setThemeHalf}
            theme={theme}
            themeHalves={themeHalves}
            onImportOpenChange={setIsImportThemeOpen}
          />
        </div>
      </SettingsSection>

      <SettingsSection id="appearance-interface" title={t("appearance.interface")}>
        <UiLocaleSettingsRow />
        <SettingsRow
          {...searchableSetting("setting-appearance-contrast")}
          description={t("appearance.contrastDescription")}
          resetAction={
            settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast ? (
              <SettingResetButton
                label={t("appearance.resetContrast")}
                onClick={() =>
                  updateSettings({
                    appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="appearance-contrast"
              >
                {settings.appearanceContrast}%
              </output>
              <input
                aria-label={t("appearance.contrast")}
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
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting("setting-glass-opacity")}
          description={t("appearance.glassOpacityDescription")}
          resetAction={
            settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? (
              <SettingResetButton
                label={t("appearance.resetGlassOpacity")}
                onClick={() =>
                  updateSettings({ glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="glass-opacity"
              >
                {settings.glassOpacity}%
              </output>
              <input
                aria-label={t("appearance.glassOpacity")}
                className="settings-slider min-w-0 flex-1"
                id="glass-opacity"
                max={MAX_GLASS_OPACITY}
                min={MIN_GLASS_OPACITY}
                onChange={(event) => {
                  const glassOpacity = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(glassOpacity) &&
                    glassOpacity >= MIN_GLASS_OPACITY &&
                    glassOpacity <= MAX_GLASS_OPACITY
                  ) {
                    updateSettings({ glassOpacity });
                  }
                }}
                step={5}
                style={glassOpacitySliderStyle}
                type="range"
                value={settings.glassOpacity}
              />
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting("chat-width")}
          description={t("appearance.chatWidthDescription")}
          resetAction={
            settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? (
              <SettingResetButton
                label={t("appearance.resetChatWidth")}
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
                  size="sm"
                  className="w-full min-w-0"
                  aria-label={t("appearance.chatWidth")}
                >
                  <SelectValue>{t(CHAT_WIDTH_LABELS[settings.chatWidth])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="comfortable">
                    {t("appearance.chatWidthComfortableDefault")}
                  </SelectItem>
                  <SelectItem value="wide">{t("appearance.chatWidthWide")}</SelectItem>
                  <SelectItem value="full">{t("appearance.chatWidthFull")}</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />
        <ThreadDetailsItemsRow />
        <SettingsRow
          {...searchableSetting("effort-display")}
          description={t("appearance.effortDisplayDescription")}
          resetAction={
            settings.effortDisplay !== DEFAULT_UNIFIED_SETTINGS.effortDisplay ? (
              <SettingResetButton
                label={t("appearance.resetEffortDisplay")}
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
                  size="sm"
                  className="w-full min-w-0"
                  aria-label={t("appearance.effortDisplay")}
                >
                  <SelectValue>{t(EFFORT_DISPLAY_LABELS[settings.effortDisplay])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="label">{t("appearance.effortWordDefault")}</SelectItem>
                  <SelectItem value="bars">{t("appearance.effortBars")}</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("math-rendering")}
          description={t("appearance.mathRenderingDescription")}
          resetAction={
            settings.mathRenderingEnabled !== DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled ? (
              <SettingResetButton
                label={t("appearance.resetMathRendering")}
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
              aria-label={t("appearance.renderMath")}
            />
          }
        />
        <AdvancedSettings
          targetIds={[
            searchableSetting("panel-animations").id,
            searchableSetting("environment-identification").id,
            // Environment identification's search result lands on this section.
            "appearance-interface",
            searchableSetting("composer-context").id,
          ]}
        >
          <SettingsRow
            {...searchableSetting("panel-animations")}
            description={t("appearance.panelAnimationsDescription")}
            control={
              <div className="grid w-full grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 sm:w-auto sm:grid-cols-[7rem_13rem] sm:gap-4">
                <PanelAnimationsPreview durationMs={settings.panelAnimationDurationMs} />
                <div className="flex w-full items-center gap-3">
                  <output
                    className="min-w-16 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                    htmlFor="panel-animation-duration"
                  >
                    {settings.panelAnimationDurationMs} ms
                  </output>
                  <input
                    aria-label={t("appearance.panelAnimationDuration")}
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
                  label={t("appearance.resetPanelAnimations")}
                  onClick={() =>
                    updateSettings({
                      panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
                    })
                  }
                />
              ) : null
            }
          />
          <SettingsRow
            {...searchableSetting("environment-identification")}
            description={environmentIdentificationDescription}
            resetAction={
              settings.environmentIdentificationMode !== DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE ? (
                <SettingResetButton
                  label={t("appearance.resetEnvironmentIdentification")}
                  onClick={() =>
                    updateSettings({
                      environmentIdentificationMode: DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
                    })
                  }
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
                  if (option) updateSettings({ environmentIdentificationMode: option[0] });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label={t("appearance.environmentIdentification")}
                >
                  <SelectValue>{environmentIdentificationLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {environmentIdentificationOptionList.map(([value, label]) => (
                    <SelectItem hideIndicator key={value} value={value}>
                      {t(label)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            {...searchableSetting("composer-context")}
            description={t("appearance.composerContextDescription")}
            resetAction={
              settings.persistComposerContextStrip !==
              DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip ? (
                <SettingResetButton
                  label={t("appearance.resetComposerContext")}
                  onClick={() =>
                    updateSettings({
                      persistComposerContextStrip:
                        DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.persistComposerContextStrip}
                onCheckedChange={(checked) =>
                  updateSettings({ persistComposerContextStrip: Boolean(checked) })
                }
                aria-label={t("appearance.composerContextAria")}
              />
            }
          />
        </AdvancedSettings>
      </SettingsSection>

      <TypographySection />
    </SettingsPageContainer>
  );
}
