import { InterfaceLanguage } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";

import { persistClientSettingsPatch, useClientSettings } from "../../hooks/useSettings";
import { useTranslation } from "../../i18n";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const isInterfaceLanguage = Schema.is(InterfaceLanguage);

export function LanguageSettings() {
  const t = useTranslation();
  const language = useClientSettings((settings) => settings.interfaceLanguage);
  return (
    <SettingsSection title={t("Interface")}>
      <SettingsRow
        id="interface-language"
        title={t("Interface language")}
        description={t("Choose the language used on this device.")}
        control={
          <Select
            value={language}
            onValueChange={(value) => {
              if (isInterfaceLanguage(value)) {
                void persistClientSettingsPatch({ interfaceLanguage: value });
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-40"
              aria-label={t("Interface language")}
            >
              <SelectValue>{language === "zh-CN" ? "简体中文" : "English"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="zh-CN">简体中文</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
