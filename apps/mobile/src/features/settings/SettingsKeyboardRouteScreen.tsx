import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  DEFAULT_COMPOSER_ENTER_BEHAVIOR,
  type ComposerEnterBehavior,
} from "../../lib/composerEnterBehavior";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsSection } from "./components/SettingsSection";

const ENTER_BEHAVIOR_OPTIONS: ReadonlyArray<{
  readonly behavior: ComposerEnterBehavior;
  readonly label: string;
  readonly description: string;
}> = [
  {
    behavior: "send",
    label: "Send message",
    description: "Return sends the message. Shift-Return inserts a new line.",
  },
  {
    behavior: "newline",
    label: "Insert new line",
    description: "Return inserts a new line. Command-Return sends the message.",
  },
];

export function SettingsKeyboardRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selectedBehavior = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.composerEnterBehavior ?? DEFAULT_COMPOSER_ENTER_BEHAVIOR)
    : null;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Keyboard & voice" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Voice input">
          <SettingsSwitchRow
            icon="mic"
            label="Send immediately"
            subtitle="Send the full composer message when transcription finishes. Off by default, so you can review the text first."
            value={
              AsyncResult.isSuccess(preferencesResult) &&
              preferencesResult.value.voiceInputSendImmediately === true
            }
            disabled={!preferencesReady}
            onValueChange={(value) => savePreferences({ voiceInputSendImmediately: value })}
          />
        </SettingsSection>
        <SettingsSection title="Return key">
          {ENTER_BEHAVIOR_OPTIONS.map((option, index) => (
            <Pressable
              key={option.behavior}
              accessibilityRole="radio"
              accessibilityState={{
                checked: selectedBehavior === option.behavior,
                disabled: !preferencesReady,
              }}
              disabled={!preferencesReady}
              onPress={() => savePreferences({ composerEnterBehavior: option.behavior })}
              className={
                index === 0
                  ? "flex-row items-center gap-4 p-4"
                  : "flex-row items-center gap-4 border-t border-border-subtle p-4"
              }
            >
              <View className="min-w-0 flex-1 gap-1">
                <Text className="text-lg text-foreground">{option.label}</Text>
                <Text className="text-sm leading-normal text-foreground-muted">
                  {option.description}
                </Text>
              </View>
              {selectedBehavior === option.behavior ? (
                <SymbolView
                  name="checkmark"
                  size={18}
                  tintColorClassName={"accent-icon"}
                  type="monochrome"
                  weight="semibold"
                />
              ) : null}
            </Pressable>
          ))}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">
          Applies to the composer when a hardware keyboard is connected.
        </Text>
      </ScrollView>
    </View>
  );
}
