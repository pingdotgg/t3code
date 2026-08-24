import type { Locale } from "../../i18n/locale";
import { useI18n } from "../../i18n/I18nProvider";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export const LANGUAGE_OPTIONS: ReadonlyArray<{
  readonly value: Locale;
  readonly label: string;
}> = [
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
];

export function applyLanguageSelection(value: unknown, setLocale: (locale: Locale) => void): void {
  if (value === "en" || value === "zh-CN") setLocale(value);
}

export function isDefaultLocalePreference(locale: Locale): boolean {
  return locale === "en";
}

export function LanguageSettings() {
  const { locale, setLocale, t } = useI18n();
  const selectedLabel =
    LANGUAGE_OPTIONS.find((option) => option.value === locale)?.label ?? "English";

  return (
    <SettingsRow
      id={searchableSetting("interface-language").id}
      title={t("settings.language.title")}
      description={t("settings.language.description")}
      resetAction={
        !isDefaultLocalePreference(locale) ? (
          <SettingResetButton
            label={t("settings.language.resetLabel")}
            onClick={() => setLocale("en")}
          />
        ) : null
      }
      control={
        <Select value={locale} onValueChange={(value) => applyLanguageSelection(value, setLocale)}>
          <SelectTrigger className="w-full sm:w-40" aria-label={t("settings.language.preference")}>
            <SelectValue>{selectedLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {LANGUAGE_OPTIONS.map((option) => (
              <SelectItem hideIndicator key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
