import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD,
  type PastedTextAttachmentThreshold,
} from "@t3tools/contracts";
import { pastedTextThresholdLabel } from "@t3tools/client-runtime/text-paste";
import { AsyncResult } from "effect/reactivity";
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

const THRESHOLD_OPTIONS: ReadonlyArray<{
  readonly threshold: PastedTextAttachmentThreshold;
  readonly description: string;
}> = [
  { threshold: 1_000, description: "Most logs, stack traces, and code snippets become files." },
  { threshold: 5_000, description: "Long logs and documents become files; snippets stay as text." },
  { threshold: 32_768, description: "Default. Only very large pastes become files." },
];

const PASTE_AS_TEXT_SHORTCUT = Platform.OS === "ios" ? "Command + Shift + V" : "Ctrl + Shift + V";

export function SettingsFollowUpRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selectedBehavior = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR)
    : null;
  const selectedThreshold = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.pastedTextAttachmentThreshold ??
      DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD)
    : null;

  const content = (
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
      <SettingsSection title="Attach pastes as files from">
        {THRESHOLD_OPTIONS.map(({ threshold, description }, index) => (
          <SettingsChoiceRow
            key={threshold}
            label={pastedTextThresholdLabel(threshold)}
            description={description}
            selected={selectedThreshold === threshold}
            separated={index > 0}
            disabled={!preferencesReady}
            onPress={() => savePreferences({ pastedTextAttachmentThreshold: threshold })}
          />
        ))}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Shorter pastes go into the message as text. Non-Latin text and emoji use more bytes per
        character, so they reach the limit sooner. With a hardware keyboard, press{" "}
        {PASTE_AS_TEXT_SHORTCUT} to paste a long block as text instead.
      </Text>
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
