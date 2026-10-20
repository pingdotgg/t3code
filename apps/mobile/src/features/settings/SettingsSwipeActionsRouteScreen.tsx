import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  DEFAULT_THREAD_SWIPE_LEADING_ACTION,
  DEFAULT_THREAD_SWIPE_TRAILING_ACTION,
  type ThreadSwipeActionChoice,
} from "../../lib/threadSwipeAction";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSection } from "./components/SettingsSection";

const SWIPE_ACTION_OPTIONS: ReadonlyArray<{
  readonly choice: ThreadSwipeActionChoice;
  readonly label: string;
}> = [
  { choice: "settle", label: "Settle" },
  { choice: "snooze", label: "Snooze" },
  { choice: "archive", label: "Archive" },
  { choice: "delete", label: "Delete" },
  { choice: "none", label: "Nothing" },
];

export function SettingsSwipeActionsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;
  const leading = preferences?.threadSwipeLeadingAction ?? DEFAULT_THREAD_SWIPE_LEADING_ACTION;
  const trailing = preferences?.threadSwipeTrailingAction ?? DEFAULT_THREAD_SWIPE_TRAILING_ACTION;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Swipe actions" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Swipe right">
          {SWIPE_ACTION_OPTIONS.map((option, index) => (
            <SettingsChoiceRow
              key={option.choice}
              label={option.label}
              selected={leading === option.choice}
              separated={index > 0}
              disabled={!preferencesReady}
              onPress={() => savePreferences({ threadSwipeLeadingAction: option.choice })}
            />
          ))}
        </SettingsSection>
        <SettingsSection title="Swipe left">
          {SWIPE_ACTION_OPTIONS.map((option, index) => (
            <SettingsChoiceRow
              key={option.choice}
              label={option.label}
              selected={trailing === option.choice}
              separated={index > 0}
              disabled={!preferencesReady}
              onPress={() => savePreferences({ threadSwipeTrailingAction: option.choice })}
            />
          ))}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">
          Applies to thread rows in the thread list. On a snoozed thread, Snooze wakes it instead.
          Snooze asks when to wake the thread, so it only reveals its button. Every other action
          also runs when you swipe all the way across.
        </Text>
      </ScrollView>
    </View>
  );
}
