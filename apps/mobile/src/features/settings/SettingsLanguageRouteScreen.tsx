import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { I18nProvider, useGT, useLanguagePreference } from "../../i18n/I18nProvider";
import { SUPPORTED_LOCALES, SYSTEM_LANGUAGE, nativeLanguageName } from "../../i18n/locales";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";

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
