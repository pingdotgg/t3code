import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { SentMessageDisplay } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Platform } from "react-native";
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

const SENT_MESSAGE_DISPLAY_OPTIONS: ReadonlyArray<{
  readonly display: SentMessageDisplay;
  readonly label: string;
}> = [
  { display: "minimize", label: "Minimize" },
  { display: "hide", label: "Hide" },
];

const SENT_MESSAGE_SECTIONS = [
  { key: "agentMessageDisplay", title: "Messages from other agents" },
  { key: "automationMessageDisplay", title: "Messages from automations" },
] as const;

export function SettingsFollowUpRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selectedBehavior = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR)
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
        keyboard, hold {Platform.OS === "android" ? "Ctrl" : "Command"} while sending.
      </Text>
      {SENT_MESSAGE_SECTIONS.map((section) => {
        const selected = AsyncResult.isSuccess(preferencesResult)
          ? (preferencesResult.value[section.key] ?? "minimize")
          : null;
        return (
          <SettingsSection key={section.key} title={section.title}>
            {SENT_MESSAGE_DISPLAY_OPTIONS.map((option, index) => (
              <SettingsChoiceRow
                key={option.display}
                label={option.label}
                selected={selected === option.display}
                separated={index > 0}
                disabled={!preferencesReady}
                onPress={() => savePreferences({ [section.key]: option.display })}
              />
            ))}
          </SettingsSection>
        );
      })}
    </ScrollView>
  );

  return <SettingsScreen title="Chat">{content}</SettingsScreen>;
}
