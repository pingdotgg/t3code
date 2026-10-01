import {
  DEFAULT_BROWSER_LINK_TARGET,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  FILL_PREVIEW_VIEWPORT,
  type PreviewAppearancePreference,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import {
  DEFAULT_CODE_FONT,
  DEFAULT_SIDEBAR_ROW_SPACING,
  DEFAULT_SIDEBAR_TRANSLUCENCY,
  DEFAULT_UI_DENSITY,
  DEFAULT_UI_FONT,
  DEFAULT_UNIFIED_SETTINGS,
  RECOMMENDED_FONT_SIZES_BY_UI_DENSITY,
  type SidebarRowSpacing,
  type UiDensity,
} from "@t3tools/contracts/settings";
import { isElectronRuntime } from "../../env";
import { useTheme } from "../../hooks/useTheme";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  CODE_FONT_OPTIONS,
  FONT_SIZE_OPTIONS,
  formatMessagePreviewLineCount,
  HEADER_BEHAVIOR_ROWS,
  HEADER_VISIBILITY_ROWS,
  HeaderSidebarToggleRows,
  isCodeFont,
  isFontSize,
  isMessagePreviewLineCount,
  isUiFont,
  MESSAGE_PREVIEW_LINE_OPTIONS,
  PANEL_TOGGLE_ROWS,
  SIDEBAR_ROW_SPACING_OPTIONS,
  SIDEBAR_TRANSLUCENCY_OPTIONS,
  SIDEBAR_VISIBILITY_ROWS,
  THEME_OPTIONS,
  TIMESTAMP_FORMAT_LABELS,
  UI_DENSITY_OPTIONS,
  UI_FONT_OPTIONS,
} from "./SettingsPanels";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

export function AppearanceSettingsPanel() {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const recommendedFontSizes = RECOMMENDED_FONT_SIZES_BY_UI_DENSITY[settings.uiDensity];

  return (
    <SettingsPageContainer>
      <SettingsPageHeader
        title="Appearance"
        description="Control how T3 Code looks: theme, density, fonts, header and sidebar buttons, and preview display."
      />

      <SettingsSection title="General">
        <SettingsRow
          title="Theme"
          description="Choose how T3 Code looks across the app."
          resetAction={
            theme !== "system" ? (
              <SettingResetButton label="theme" onClick={() => setTheme("system")} />
            ) : null
          }
          control={
            <Select
              value={theme}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark") {
                  setTheme(value);
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Theme preference">
                <SelectValue>
                  {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {THEME_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

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
          title="UI density"
          description="Control spacing and type size across the entire interface — sidebar, chat, composer, and toolbars. Changing this applies the recommended font sizes for that density; each size stays adjustable below."
          resetAction={
            settings.uiDensity !== DEFAULT_UI_DENSITY ? (
              <SettingResetButton
                label="UI density"
                onClick={() =>
                  updateSettings({
                    uiDensity: DEFAULT_UI_DENSITY,
                    ...RECOMMENDED_FONT_SIZES_BY_UI_DENSITY[DEFAULT_UI_DENSITY],
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.uiDensity}
              onValueChange={(value) => {
                if (UI_DENSITY_OPTIONS.some((option) => option.value === value)) {
                  const density = value as UiDensity;
                  updateSettings({
                    uiDensity: density,
                    ...RECOMMENDED_FONT_SIZES_BY_UI_DENSITY[density],
                  });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="UI density">
                <SelectValue>
                  {UI_DENSITY_OPTIONS.find((option) => option.value === settings.uiDensity)
                    ?.label ?? "Default"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {UI_DENSITY_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    <div>
                      <span className="font-medium">{option.label}</span>
                      <span className="ml-2 text-muted-foreground/70">{option.hint}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        {isElectronRuntime() && (
          <SettingsRow
            title="Sidebar translucency"
            description="Control the sidebar's frosted tint. Desktop builds use native vibrancy when available, with CSS blur as a fallback."
            resetAction={
              settings.sidebarTranslucency !== DEFAULT_SIDEBAR_TRANSLUCENCY ? (
                <SettingResetButton
                  label="sidebar translucency"
                  onClick={() =>
                    updateSettings({ sidebarTranslucency: DEFAULT_SIDEBAR_TRANSLUCENCY })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.sidebarTranslucency}
                onValueChange={(value) => {
                  if (
                    value === "off" ||
                    value === "subtle" ||
                    value === "medium" ||
                    value === "strong" ||
                    value === "liquid-glass"
                  ) {
                    updateSettings({ sidebarTranslucency: value });
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label="Sidebar translucency">
                  <SelectValue>
                    {SIDEBAR_TRANSLUCENCY_OPTIONS.find(
                      (option) => option.value === settings.sidebarTranslucency,
                    )?.label ?? "Off"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {SIDEBAR_TRANSLUCENCY_OPTIONS.map((option) => (
                    <SelectItem hideIndicator key={option.value} value={option.value}>
                      <div>
                        <span className="font-medium">{option.label}</span>
                        <span className="ml-2 text-muted-foreground/70">{option.hint}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        )}
      </SettingsSection>

      <SettingsSection title="Sidebar">
        <SettingsRow
          title="Inbox sidebar (beta)"
          description="Use the flat inbox with active, snoozed, and settled thread shelves."
          resetAction={
            settings.sidebarV2Enabled !== DEFAULT_UNIFIED_SETTINGS.sidebarV2Enabled ? (
              <SettingResetButton
                label="inbox sidebar"
                onClick={() =>
                  updateSettings({ sidebarV2Enabled: DEFAULT_UNIFIED_SETTINGS.sidebarV2Enabled })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.sidebarV2Enabled}
              onCheckedChange={(checked) => updateSettings({ sidebarV2Enabled: Boolean(checked) })}
            />
          }
        />
        <SettingsRow
          title="Sidebar row spacing"
          description="Control the padding inside sidebar rows and the gap between them."
          resetAction={
            settings.sidebarRowSpacing !== DEFAULT_SIDEBAR_ROW_SPACING ? (
              <SettingResetButton
                label="sidebar row spacing"
                onClick={() => updateSettings({ sidebarRowSpacing: DEFAULT_SIDEBAR_ROW_SPACING })}
              />
            ) : null
          }
          control={
            <Select
              value={settings.sidebarRowSpacing}
              onValueChange={(value) => {
                if (SIDEBAR_ROW_SPACING_OPTIONS.some((option) => option.value === value)) {
                  updateSettings({ sidebarRowSpacing: value as SidebarRowSpacing });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Sidebar row spacing">
                <SelectValue>
                  {SIDEBAR_ROW_SPACING_OPTIONS.find(
                    (option) => option.value === settings.sidebarRowSpacing,
                  )?.label ?? "Default"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {SIDEBAR_ROW_SPACING_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    <div>
                      <span className="font-medium">{option.label}</span>
                      <span className="ml-2 text-muted-foreground/70">{option.hint}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Header & sidebar buttons">
        <HeaderSidebarToggleRows
          rows={HEADER_VISIBILITY_ROWS}
          settings={settings}
          updateSettings={updateSettings}
        />
        <HeaderSidebarToggleRows
          rows={PANEL_TOGGLE_ROWS}
          settings={settings}
          updateSettings={updateSettings}
        />
        <HeaderSidebarToggleRows
          rows={SIDEBAR_VISIBILITY_ROWS}
          settings={settings}
          updateSettings={updateSettings}
        />
        <HeaderSidebarToggleRows
          rows={HEADER_BEHAVIOR_ROWS}
          settings={settings}
          updateSettings={updateSettings}
        />
      </SettingsSection>

      <SettingsSection title="Fonts">
        <SettingsRow
          title="Interface font"
          description="Choose the sans-serif typeface used throughout the app UI."
          resetAction={
            settings.uiFont !== DEFAULT_UI_FONT ? (
              <SettingResetButton
                label="interface font"
                onClick={() => updateSettings({ uiFont: DEFAULT_UI_FONT })}
              />
            ) : null
          }
          control={
            <Select
              value={settings.uiFont}
              onValueChange={(value) => {
                if (isUiFont(value)) updateSettings({ uiFont: value });
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Interface font">
                <SelectValue>
                  {UI_FONT_OPTIONS.find((option) => option.value === settings.uiFont)?.label ??
                    "DM Sans"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {UI_FONT_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Code font"
          description="Choose the monospace typeface used for code blocks, diffs, and terminals."
          resetAction={
            settings.codeFont !== DEFAULT_CODE_FONT ? (
              <SettingResetButton
                label="code font"
                onClick={() => updateSettings({ codeFont: DEFAULT_CODE_FONT })}
              />
            ) : null
          }
          control={
            <Select
              value={settings.codeFont}
              onValueChange={(value) => {
                if (isCodeFont(value)) updateSettings({ codeFont: value });
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Code font">
                <SelectValue>
                  {CODE_FONT_OPTIONS.find((option) => option.value === settings.codeFont)?.label ??
                    "System mono"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {CODE_FONT_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Code font size"
          description="Font size for code blocks, diffs, and terminals."
          resetAction={
            settings.codeFontSize !== recommendedFontSizes.codeFontSize ? (
              <SettingResetButton
                label="code font size"
                onClick={() => updateSettings({ codeFontSize: recommendedFontSizes.codeFontSize })}
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.codeFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) updateSettings({ codeFontSize: num });
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Code font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.codeFontSize)
                    ?.label ?? `${recommendedFontSizes.codeFontSize}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Chat font size"
          description="Font size for assistant and user messages in the chat."
          resetAction={
            settings.chatFontSize !== recommendedFontSizes.chatFontSize ? (
              <SettingResetButton
                label="chat font size"
                onClick={() => updateSettings({ chatFontSize: recommendedFontSizes.chatFontSize })}
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.chatFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) updateSettings({ chatFontSize: num });
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Chat font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.chatFontSize)
                    ?.label ?? `${recommendedFontSizes.chatFontSize}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        {(
          [
            {
              key: "normal",
              title: "Normal message preview",
              description: "Lines shown before expanding messages sent directly in a chat.",
            },
            {
              key: "crossThread",
              title: "Cross-thread message preview",
              description: "Lines shown before expanding messages sent from another chat.",
            },
            {
              key: "monitoring",
              title: "Monitoring message preview",
              description: "Lines shown before expanding pull request monitoring messages.",
            },
          ] as const
        ).map(({ key, title, description }) => (
          <SettingsRow
            key={key}
            title={title}
            description={description}
            resetAction={
              settings.messagePreviewLineLimits[key] !==
              DEFAULT_UNIFIED_SETTINGS.messagePreviewLineLimits[key] ? (
                <SettingResetButton
                  label={title.toLowerCase()}
                  onClick={() =>
                    updateSettings({
                      messagePreviewLineLimits: {
                        ...settings.messagePreviewLineLimits,
                        [key]: DEFAULT_UNIFIED_SETTINGS.messagePreviewLineLimits[key],
                      },
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={String(settings.messagePreviewLineLimits[key])}
                onValueChange={(value) => {
                  const lineCount = Number(value);
                  if (isMessagePreviewLineCount(lineCount)) {
                    updateSettings({
                      messagePreviewLineLimits: {
                        ...settings.messagePreviewLineLimits,
                        [key]: lineCount,
                      },
                    });
                  }
                }}
              >
                <SelectTrigger className="w-full sm:w-40" aria-label={title}>
                  <SelectValue>
                    {formatMessagePreviewLineCount(settings.messagePreviewLineLimits[key])}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {MESSAGE_PREVIEW_LINE_OPTIONS.map((lineCount) => (
                    <SelectItem hideIndicator key={lineCount} value={String(lineCount)}>
                      {formatMessagePreviewLineCount(lineCount)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ))}
        <SettingsRow
          title="Status line font size"
          description="Font size for assistant metadata lines, including timestamps, elapsed time, and resume commands."
          resetAction={
            settings.statusLineFontSize !== recommendedFontSizes.statusLineFontSize ? (
              <SettingResetButton
                label="status line font size"
                onClick={() =>
                  updateSettings({ statusLineFontSize: recommendedFontSizes.statusLineFontSize })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.statusLineFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) updateSettings({ statusLineFontSize: num });
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Status line font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.statusLineFontSize)
                    ?.label ?? `${recommendedFontSizes.statusLineFontSize}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Input font size"
          description="Font size for the message composer, its controls, and menus."
          resetAction={
            settings.inputFontSize !== recommendedFontSizes.inputFontSize ? (
              <SettingResetButton
                label="input font size"
                onClick={() =>
                  updateSettings({ inputFontSize: recommendedFontSizes.inputFontSize })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.inputFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) updateSettings({ inputFontSize: num });
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Input font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.inputFontSize)
                    ?.label ?? `${recommendedFontSizes.inputFontSize}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Sidebar font size"
          description="Font size for project and chat titles in the sidebar."
          resetAction={
            settings.sidebarFontSize !== recommendedFontSizes.sidebarFontSize ? (
              <SettingResetButton
                label="sidebar font size"
                onClick={() =>
                  updateSettings({ sidebarFontSize: recommendedFontSizes.sidebarFontSize })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.sidebarFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) updateSettings({ sidebarFontSize: num });
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Sidebar font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.sidebarFontSize)
                    ?.label ?? `${recommendedFontSizes.sidebarFontSize}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Sidebar icon size"
          description="Icon size for action and row icons across the sidebar. Status glyphs stay on their own smaller tier."
          resetAction={
            settings.sidebarIconSize !== recommendedFontSizes.sidebarIconSize ? (
              <SettingResetButton
                label="sidebar icon size"
                onClick={() =>
                  updateSettings({ sidebarIconSize: recommendedFontSizes.sidebarIconSize })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.sidebarIconSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) updateSettings({ sidebarIconSize: num });
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Sidebar icon size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.sidebarIconSize)
                    ?.label ?? `${recommendedFontSizes.sidebarIconSize}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Sidebar metadata font size"
          description="Font size for the project name, worktree, branch, pull request, and timestamps on sidebar rows."
          resetAction={
            settings.sidebarMetaFontSize !== recommendedFontSizes.sidebarMetaFontSize ? (
              <SettingResetButton
                label="sidebar metadata font size"
                onClick={() =>
                  updateSettings({ sidebarMetaFontSize: recommendedFontSizes.sidebarMetaFontSize })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.sidebarMetaFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) updateSettings({ sidebarMetaFontSize: num });
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Sidebar metadata font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.sidebarMetaFontSize)
                    ?.label ?? `${recommendedFontSizes.sidebarMetaFontSize}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Tool output font size"
          description="Font size for work log entries and tool call output."
          resetAction={
            settings.toolFontSize !== recommendedFontSizes.toolFontSize ? (
              <SettingResetButton
                label="tool output font size"
                onClick={() => updateSettings({ toolFontSize: recommendedFontSizes.toolFontSize })}
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.toolFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) updateSettings({ toolFontSize: num });
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Tool output font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find((option) => option.value === settings.toolFontSize)
                    ?.label ?? `${recommendedFontSizes.toolFontSize}px`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Pull requests display">
        <SettingsRow
          title="Diff code font size"
          description="Font size for code in pull request diffs."
          resetAction={
            settings.pullRequestsCodeFontSize !==
            DEFAULT_UNIFIED_SETTINGS.pullRequestsCodeFontSize ? (
              <SettingResetButton
                label="pull requests code font size"
                onClick={() =>
                  updateSettings({
                    pullRequestsCodeFontSize: DEFAULT_UNIFIED_SETTINGS.pullRequestsCodeFontSize,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.pullRequestsCodeFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) updateSettings({ pullRequestsCodeFontSize: num });
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Pull requests code font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find(
                    (option) => option.value === settings.pullRequestsCodeFontSize,
                  )?.label ?? "12px"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Body font size"
          description="Font size for pull request descriptions and comments."
          resetAction={
            settings.pullRequestsBodyFontSize !==
            DEFAULT_UNIFIED_SETTINGS.pullRequestsBodyFontSize ? (
              <SettingResetButton
                label="pull requests body font size"
                onClick={() =>
                  updateSettings({
                    pullRequestsBodyFontSize: DEFAULT_UNIFIED_SETTINGS.pullRequestsBodyFontSize,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.pullRequestsBodyFontSize)}
              onValueChange={(value) => {
                const num = Number(value);
                if (isFontSize(num)) updateSettings({ pullRequestsBodyFontSize: num });
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Pull requests body font size">
                <SelectValue>
                  {FONT_SIZE_OPTIONS.find(
                    (option) => option.value === settings.pullRequestsBodyFontSize,
                  )?.label ?? "14px"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Wrap long diff lines"
          description="Wrap instead of horizontally scrolling long lines in pull request diffs."
          resetAction={
            settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
              <SettingResetButton
                label="pull requests diff line wrapping"
                onClick={() =>
                  updateSettings({ diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffWordWrap}
              onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
              aria-label="Wrap long lines in pull request diffs"
            />
          }
        />
        <SettingsRow
          title="Diff line wrapping"
          description="Set the default wrap state when the diff panel opens."
          resetAction={
            settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
              <SettingResetButton
                label="diff line wrapping"
                onClick={() =>
                  updateSettings({ diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.diffWordWrap}
              onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
              aria-label="Wrap diff lines by default"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Browser display">
        <SettingsRow
          title="Browser default viewport"
          description="Choose the viewport size used by new browser tabs unless an entry point provides an explicit size."
          resetAction={
            settings.browserDefaultViewport._tag !== FILL_PREVIEW_VIEWPORT._tag ? (
              <SettingResetButton
                label="browser default viewport"
                onClick={() => updateSettings({ browserDefaultViewport: FILL_PREVIEW_VIEWPORT })}
              />
            ) : null
          }
          control={
            <Select
              value={
                settings.browserDefaultViewport._tag === "fill"
                  ? "fill"
                  : `${settings.browserDefaultViewport.width}x${settings.browserDefaultViewport.height}`
              }
              onValueChange={(value) => {
                if (value === null) return;
                const next: Record<string, PreviewViewportSetting> = {
                  fill: FILL_PREVIEW_VIEWPORT,
                  "1440x900": { _tag: "freeform", width: 1440, height: 900 },
                  "1024x768": { _tag: "freeform", width: 1024, height: 768 },
                  "390x844": { _tag: "freeform", width: 390, height: 844 },
                };
                const viewport = next[value];
                if (viewport) updateSettings({ browserDefaultViewport: viewport });
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Browser default viewport">
                <SelectValue>
                  {settings.browserDefaultViewport._tag === "fill"
                    ? "Panel size"
                    : `${settings.browserDefaultViewport.width} x ${settings.browserDefaultViewport.height}`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="fill">
                  Panel size
                </SelectItem>
                <SelectItem hideIndicator value="1440x900">
                  Desktop (1440 x 900)
                </SelectItem>
                <SelectItem hideIndicator value="1024x768">
                  Tablet (1024 x 768)
                </SelectItem>
                <SelectItem hideIndicator value="390x844">
                  Mobile (390 x 844)
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Browser default zoom"
          description="Set the initial zoom factor for human and agent browser tabs."
          resetAction={
            settings.browserDefaultZoomFactor !== DEFAULT_PREVIEW_ZOOM_FACTOR ? (
              <SettingResetButton
                label="browser default zoom"
                onClick={() =>
                  updateSettings({ browserDefaultZoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR })
                }
              />
            ) : null
          }
          control={
            <Select
              value={String(settings.browserDefaultZoomFactor)}
              onValueChange={(value) => {
                const zoom = Number(value);
                if ([0.8, 1, 1.25, 1.5].includes(zoom)) {
                  updateSettings({
                    browserDefaultZoomFactor: zoom as typeof settings.browserDefaultZoomFactor,
                  });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Browser default zoom">
                <SelectValue>{Math.round(settings.browserDefaultZoomFactor * 100)}%</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {[0.8, 1, 1.25, 1.5].map((zoom) => (
                  <SelectItem hideIndicator key={zoom} value={String(zoom)}>
                    {Math.round(zoom * 100)}%
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Browser default appearance"
          description="Choose the color scheme applied when a new browser tab is created."
          resetAction={
            settings.browserDefaultAppearance !== DEFAULT_PREVIEW_APPEARANCE ? (
              <SettingResetButton
                label="browser default appearance"
                onClick={() =>
                  updateSettings({ browserDefaultAppearance: DEFAULT_PREVIEW_APPEARANCE })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.browserDefaultAppearance}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark") {
                  updateSettings({
                    browserDefaultAppearance: value as PreviewAppearancePreference,
                  });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Browser default appearance">
                <SelectValue>
                  {settings.browserDefaultAppearance === "system"
                    ? "System"
                    : settings.browserDefaultAppearance === "light"
                      ? "Light"
                      : "Dark"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="system">
                  System
                </SelectItem>
                <SelectItem hideIndicator value="light">
                  Light
                </SelectItem>
                <SelectItem hideIndicator value="dark">
                  Dark
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Open links in"
          description="Choose whether HTTP(S) links open in T3 Code or your system browser. Cmd/Ctrl/Shift/Alt-click always opens externally."
          resetAction={
            settings.browserLinkTarget !== DEFAULT_BROWSER_LINK_TARGET ? (
              <SettingResetButton
                label="link destination"
                onClick={() => updateSettings({ browserLinkTarget: DEFAULT_BROWSER_LINK_TARGET })}
              />
            ) : null
          }
          control={
            <Select
              value={settings.browserLinkTarget}
              onValueChange={(value) => {
                if (value === "system" || value === "app") {
                  updateSettings({ browserLinkTarget: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Open links in">
                <SelectValue>
                  {settings.browserLinkTarget === "app" ? "T3 Code" : "System browser"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="app">
                  T3 Code
                </SelectItem>
                <SelectItem hideIndicator value="system">
                  System browser
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
