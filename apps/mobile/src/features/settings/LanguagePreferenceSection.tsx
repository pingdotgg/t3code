import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useTranslation } from "@t3tools/i18n/react";
import type { LocalePreference } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "./components/SettingsSection";

const OPTIONS: ReadonlyArray<LocalePreference> = ["system", "en", "zh-CN"];

export function LanguagePreferenceSection() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preference = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.localePreference ?? "system")
    : "system";
  const { t } = useTranslation();
  const labels: Readonly<Record<LocalePreference, string>> = {
    system: t("systemDefault"),
    en: t("english"),
    "zh-CN": t("simplifiedChinese"),
  };

  return (
    <SettingsSection title={t("language")}>
      <View className="overflow-hidden rounded-2xl border border-border bg-grouped-card">
        {OPTIONS.map((option, index) => {
          const selected = preference === option;
          return (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              className={`min-h-12 flex-row items-center justify-between px-4 ${index > 0 ? "border-t border-border" : ""}`}
              onPress={() => updatePreferences({ localePreference: option })}
            >
              <Text className="text-base text-foreground">{labels[option]}</Text>
              {selected ? (
                <SymbolView name="checkmark" size={18} tintColorClassName="accent-icon" />
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </SettingsSection>
  );
}
