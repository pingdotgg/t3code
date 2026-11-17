import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useGT } from "gt-react-native";
import { I18nProvider, useLanguagePreference } from "../../i18n/I18nProvider";
import { SYSTEM_LANGUAGE, nativeLanguageName } from "@t3tools/client-runtime/locales";
import { SUPPORTED_LOCALES } from "../../i18n/locales";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";

/** General's row that opens the language picker, showing the current choice. */
export function LanguageSettingsSection() {
  return (
    <I18nProvider>
      <LanguageRow />
    </I18nProvider>
  );
}

function LanguageRow() {
  const gt = useGT();
  const language = useLanguagePreference();
  return (
    <SettingsSection>
      <SettingsRow
        icon="globe"
        label={gt("Language")}
        value={
          SUPPORTED_LOCALES.includes(language) ? nativeLanguageName(language) : gt("System default")
        }
        target="SettingsLanguage"
      />
    </SettingsSection>
  );
}

export function SettingsLanguageRouteScreen() {
  return (
    <I18nProvider>
      <LanguageSettings />
    </I18nProvider>
  );
}

function LanguageSettings() {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const language = useLanguagePreference();
  const options = [
    { language: SYSTEM_LANGUAGE, label: gt("System default") },
    ...SUPPORTED_LOCALES.map((locale) => ({ language: locale, label: nativeLanguageName(locale) })),
  ];

  return (
    <SettingsScreen title={gt("Language")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection>
          {options.map((option, index) => (
            <SettingsChoiceRow
              key={option.language}
              label={option.label}
              selected={preferencesReady && language === option.language}
              separated={index > 0}
              disabled={!preferencesReady}
              onPress={() => savePreferences({ language: option.language })}
            />
          ))}
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
