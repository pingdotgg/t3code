import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useUsageLimitDisplayMode } from "../usage/useUsageLimitDisplayMode";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import { CodeAppearanceSection } from "./appearance/sections/CodeAppearanceSection";
import { TerminalAppearanceSection } from "./appearance/sections/TerminalAppearanceSection";
import { TextAppearanceSection } from "./appearance/sections/TextAppearanceSection";
import { ThemeAppearanceSection } from "./appearance/sections/ThemeAppearanceSection";

export function SettingsAppearanceRouteScreen() {
  const insets = useSafeAreaInsets();
  const mode = useUsageLimitDisplayMode();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferences) && !preferences.waiting;

  return (
    <SettingsScreen title="Appearance">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <ThemeAppearanceSection />
        <SettingsSection title="Limit display">
          {(["remaining", "used"] as const).map((value, index) => (
            <Pressable
              key={value}
              accessibilityRole="radio"
              accessibilityState={{ checked: mode === value, disabled: !ready }}
              disabled={!ready}
              onPress={() => savePreferences({ usageLimitDisplayMode: value })}
              className={
                index === 0
                  ? "flex-row items-center justify-between p-4"
                  : "flex-row items-center justify-between border-t border-border-subtle p-4"
              }
            >
              <Text className="text-lg text-foreground">
                {value === "remaining" ? "Remaining (default)" : "Used"}
              </Text>
              {mode === value ? (
                <SymbolView
                  name="checkmark"
                  size={18}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                  weight="semibold"
                />
              ) : null}
            </Pressable>
          ))}
        </SettingsSection>
        <TextAppearanceSection />
        <TerminalAppearanceSection />
        <CodeAppearanceSection />
      </ScrollView>
    </SettingsScreen>
  );
}
