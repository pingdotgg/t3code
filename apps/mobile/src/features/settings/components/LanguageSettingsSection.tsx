import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { useTranslation } from "../../../i18n";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import { SettingsChoiceRow } from "./SettingsChoiceRow";
import { SettingsSection } from "./SettingsSection";

export function LanguageSettingsSection() {
  const t = useTranslation();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const update = useAtomSet(updateMobilePreferencesAtom);
  const language = AsyncResult.isSuccess(preferences)
    ? (preferences.value.interfaceLanguage ?? "en")
    : "en";
  return (
    <SettingsSection title={t("Interface language")}>
      <SettingsChoiceRow
        label="English"
        selected={language === "en"}
        separated={false}
        disabled={false}
        onPress={() => update({ interfaceLanguage: "en" })}
      />
      <SettingsChoiceRow
        label="简体中文"
        selected={language === "zh-CN"}
        separated
        disabled={false}
        onPress={() => update({ interfaceLanguage: "zh-CN" })}
      />
    </SettingsSection>
  );
}
