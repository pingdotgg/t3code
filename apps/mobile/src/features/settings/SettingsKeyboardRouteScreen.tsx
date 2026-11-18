import { msg, T, useGT, useMessages } from "gt-react-native";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import {
  DEFAULT_COMPOSER_ENTER_BEHAVIOR,
  type ComposerEnterBehavior,
} from "../../lib/composerEnterBehavior";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { ListChoiceRow as SettingsChoiceRow } from "../../components/ui/ListChoiceRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

const SEND_MODIFIER = Platform.OS === "android" ? "Ctrl" : "Command";

const ENTER_BEHAVIOR_OPTIONS: ReadonlyArray<{
  readonly behavior: ComposerEnterBehavior;
  readonly label: string;
  readonly description: string;
}> = [
  {
    behavior: "send",
    label: msg("Send message"),
    description: msg("{returnKey} sends the message. {shiftReturn} inserts a new line.", {
      returnKey: "Return",
      shiftReturn: "Shift-Return",
    }),
  },
  {
    behavior: "newline",
    label: msg("Insert new line"),
    description: msg("{returnKey} inserts a new line. {sendKeys} sends the message.", {
      returnKey: "Return",
      sendKeys: `${SEND_MODIFIER}-Return`,
    }),
  },
];

export function SettingsKeyboardRouteScreen() {
  const gt = useGT();
  const m = useMessages();
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selectedBehavior = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.composerEnterBehavior ?? DEFAULT_COMPOSER_ENTER_BEHAVIOR)
    : null;

  return (
    <SettingsScreen title={gt("Keyboard")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title={gt("Return key")}>
          {ENTER_BEHAVIOR_OPTIONS.map((option, index) => (
            <SettingsChoiceRow
              key={option.behavior}
              label={m(option.label)}
              description={m(option.description)}
              selected={selectedBehavior === option.behavior}
              separated={index > 0}
              disabled={!preferencesReady}
              onPress={() => savePreferences({ composerEnterBehavior: option.behavior })}
            />
          ))}
        </SettingsSection>
        <Text className="px-2 text-sm text-foreground-muted">
          <T>Applies to the composer when a hardware keyboard is connected.</T>
        </Text>
      </ScrollView>
    </SettingsScreen>
  );
}
