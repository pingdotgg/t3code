import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { DEFAULT_FOLLOW_UP_BEHAVIOR, type FollowUpBehavior } from "../../lib/followUpBehavior";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSection } from "./components/SettingsSection";

const FOLLOW_UP_OPTIONS: ReadonlyArray<{
  readonly behavior: FollowUpBehavior;
  readonly label: string;
  readonly description: string;
}> = [
  {
    behavior: "queue",
    label: "Queue",
    description: "Your message waits and runs after the current turn finishes.",
  },
  {
    behavior: "steer",
    label: "Steer",
    description: "Your message reaches the agent right away, changing what it is working on.",
  },
];

export function SettingsFollowUpRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selectedBehavior = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR)
    : null;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Follow-ups" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="While the agent is running">
          {FOLLOW_UP_OPTIONS.map((option, index) => (
            <SettingsChoiceRow
              key={option.behavior}
              label={option.label}
              description={option.description}
              selected={selectedBehavior === option.behavior}
              separated={index > 0}
              disabled={!preferencesReady}
              onPress={() => savePreferences({ followUpBehavior: option.behavior })}
            />
          ))}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">
          Long-press the send button to use the other option for a single message. With a hardware
          keyboard, hold Command while sending.
        </Text>
      </ScrollView>
    </View>
  );
}
