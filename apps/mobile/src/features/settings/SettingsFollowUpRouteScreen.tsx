import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import type { TranscriptView } from "@t3tools/contracts";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { DEFAULT_FOLLOW_UP_BEHAVIOR, type FollowUpBehavior } from "../../lib/followUpBehavior";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";

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

const TRANSCRIPT_VIEW_OPTIONS: ReadonlyArray<{
  readonly view: TranscriptView;
  readonly label: string;
  readonly description: string;
}> = [
  {
    view: "normal",
    label: "Normal",
    description: "Each finished turn folds its work behind “Worked for”.",
  },
  {
    view: "thinking",
    label: "Thinking",
    description: "Every turn opens with its tool calls and intermediate messages.",
  },
  {
    view: "verbose",
    label: "Verbose",
    description: "Every turn opens, and so does each tool call's thinking text and output.",
  },
];

export function SettingsFollowUpRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selectedBehavior = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR)
    : null;
  const selectedTranscriptView = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.transcriptView ?? "normal")
    : null;

  const content = (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      className="flex-1"
      contentContainerClassName="gap-6 px-5 pt-4"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
    >
      <View className="gap-3">
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
      </View>
      <SettingsSection title="Transcript view">
        {TRANSCRIPT_VIEW_OPTIONS.map((option, index) => (
          <SettingsChoiceRow
            key={option.view}
            label={option.label}
            description={option.description}
            selected={selectedTranscriptView === option.view}
            separated={index > 0}
            disabled={!preferencesReady}
            onPress={() => savePreferences({ transcriptView: option.view })}
          />
        ))}
      </SettingsSection>
    </ScrollView>
  );

  return Platform.OS === "android" ? (
    <SettingsScreen title="Chat">{content}</SettingsScreen>
  ) : (
    <View collapsable={false} className="flex-1 bg-sheet">
      {content}
    </View>
  );
}
