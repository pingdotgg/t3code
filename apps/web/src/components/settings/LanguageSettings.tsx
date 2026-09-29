import { useTranslation } from "@t3tools/i18n/react";
import type { LocalePreference } from "@t3tools/contracts";

import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function LanguageSettings() {
  const preference = useClientSettings((settings) => settings.localePreference);
  const updateClientSettings = useUpdateClientSettings();
  const { t } = useTranslation();
  const { t: tSettings } = useTranslation("settings");

  return (
    <SettingsSection id="language" title={t("language")}>
      <SettingsRow
        title={t("interfaceLanguage")}
        description={tSettings("languageDescription")}
        control={
          <Select
            value={preference}
            onValueChange={(value) => {
              if (value === "system" || value === "en" || value === "zh-CN") {
                void updateClientSettings({ localePreference: value satisfies LocalePreference });
              }
            }}
          >
            <SelectTrigger aria-label={t("interfaceLanguage")}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="system">{t("systemDefault")}</SelectItem>
              <SelectItem value="en">{t("english")}</SelectItem>
              <SelectItem value="zh-CN">{t("simplifiedChinese")}</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
