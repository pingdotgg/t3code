import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSection } from "./components/SettingsSection";

// Locales Apple's on-device transcriber supports; its native module does not expose the list.
const LANGUAGES = [
  { locale: undefined, label: "Automatic", description: "Uses the app's language." },
  { locale: "en-US", label: "English (US)", description: "English (United States)" },
  { locale: "en-GB", label: "English (UK)", description: "English (United Kingdom)" },
  { locale: "es-ES", label: "Español (España)", description: "Spanish (Spain)" },
  { locale: "es-MX", label: "Español (México)", description: "Spanish (Mexico)" },
  { locale: "fr-FR", label: "Français", description: "French" },
  { locale: "de-DE", label: "Deutsch", description: "German" },
  { locale: "it-IT", label: "Italiano", description: "Italian" },
  { locale: "pt-BR", label: "Português (Brasil)", description: "Portuguese (Brazil)" },
  { locale: "ja-JP", label: "日本語", description: "Japanese" },
  { locale: "ko-KR", label: "한국어", description: "Korean" },
  { locale: "zh-CN", label: "中文（普通话）", description: "Chinese (Mandarin)" },
] as const;

export function SettingsVoiceInputRouteScreen() {
  const insets = useSafeAreaInsets();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const selectedLocale = useAtomValue(mobilePreferencesAtom, (result) =>
    AsyncResult.isSuccess(result) ? result.value.voiceInputLanguage : null,
  );

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1 bg-sheet"
      contentContainerClassName="gap-3 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
      <SettingsSection title="Language">
        {LANGUAGES.map((option, index) => (
          <SettingsChoiceRow
            key={option.label}
            label={option.label}
            description={option.description}
            selected={selectedLocale === option.locale}
            separated={index > 0}
            disabled={selectedLocale === null}
            onPress={() => savePreferences({ voiceInputLanguage: option.locale })}
          />
        ))}
      </SettingsSection>
    </ScrollView>
  );
}
