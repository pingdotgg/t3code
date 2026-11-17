import { type UiLocale, UI_LOCALES } from "@t3tools/contracts/settings";
import { useTranslation } from "react-i18next";

import { useUiLocale, writeUiLocale } from "../../hooks/useUiLocale";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

// Language names render in their own language, so only "system" is translated.
const NATIVE_LANGUAGE_LABELS: Record<Exclude<UiLocale, "system">, string> = {
  en: "English",
  "zh-Hans": "简体中文",
};

export function UiLocaleSettingsRow() {
  const { t } = useTranslation("settings");
  const uiLocale = useUiLocale();
  return (
    <SettingsRow
      {...searchableSetting("language")}
      description={t("uiLocale.description")}
      control={
        <div className="w-full sm:w-40">
          <Select
            value={uiLocale}
            onValueChange={(value) => {
              if (value === "system" || value === "en" || value === "zh-Hans") {
                writeUiLocale(value);
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label={t("uiLocale.label")}>
              <SelectValue>
                {uiLocale === "system" ? t("uiLocale.system") : NATIVE_LANGUAGE_LABELS[uiLocale]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {UI_LOCALES.map((locale) => (
                <SelectItem key={locale} value={locale}>
                  {locale === "system" ? t("uiLocale.system") : NATIVE_LANGUAGE_LABELS[locale]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}
