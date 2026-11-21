import { msg, T, useGT, useMessages } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import type { UsageLimitDisplay } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppText as Text } from "../../../../components/ui/AppText";
import { ListChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../../../state/preferences";
import { useAtomCommand } from "../../../../state/use-atom-command";
import { SettingsSection } from "../../components/SettingsSection";

const USAGE_LIMIT_DISPLAY_OPTIONS: ReadonlyArray<{
  readonly value: UsageLimitDisplay;
  readonly label: string;
}> = [
  { value: "left", label: msg("Left", { $context: "show usage limits as quota left" }) },
  { value: "used", label: msg("Used", { $context: "show usage limits as quota used" }) },
];

export function UsageLimitsAppearanceSection() {
  const gt = useGT();
  const m = useMessages();
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const selected = AsyncResult.isSuccess(preferences)
    ? (preferences.value.usageLimitDisplay ?? "left")
    : null;

  return (
    <View className="gap-3">
      <SettingsSection title={gt("Usage limits")}>
        {USAGE_LIMIT_DISPLAY_OPTIONS.map((option, index) => (
          <ListChoiceRow
            key={option.value}
            label={m(option.label)}
            selected={selected === option.value}
            separated={index > 0}
            disabled={selected === null}
            onPress={() => {
              void savePreferences({ usageLimitDisplay: option.value });
            }}
          />
        ))}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        <T>Show usage limits and their bars as the share of each limit left, or the share used.</T>
      </Text>
    </View>
  );
}
