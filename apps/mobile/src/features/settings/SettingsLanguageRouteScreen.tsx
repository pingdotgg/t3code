import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  LANGUAGE_LABELS,
  SUPPORTED_LANGUAGES,
  type LanguagePreference,
} from "@t3tools/client-runtime/i18n";

import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useTranslate } from "../../i18n";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsLanguageRouteScreen() {
  const t = useTranslate();
  const languageOptions: ReadonlyArray<{
    readonly preference: LanguagePreference;
    readonly label: string;
    readonly description: string;
  }> = [
    {
      preference: "system",
      label: t("settings.language.system"),
      description: t("settings.language.deviceDescription"),
    },
    ...SUPPORTED_LANGUAGES.map((language) => ({
      preference: language,
      label: LANGUAGE_LABELS[language],
      description: "",
    })),
  ];
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selected = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.languagePreference ?? "system")
    : null;

  return (
    <SettingsScreen title={t("settings.language.title")}>
      <NativeStackScreenOptions options={{ title: t("settings.language.title") }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title={t("settings.language.title")}>
          {languageOptions.map((option, index) => (
            <SettingsChoiceRow
              key={option.preference}
              label={option.label}
              description={option.description}
              selected={selected === option.preference}
              separated={index > 0}
              disabled={!preferencesReady}
              onPress={() => savePreferences({ languagePreference: option.preference })}
            />
          ))}
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
