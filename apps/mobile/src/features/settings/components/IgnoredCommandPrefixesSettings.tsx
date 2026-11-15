import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { parseIgnoredCommandPrefixes } from "@t3tools/client-runtime/work-log/command-label";
import { useRef } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import {
  ignoredCommandPrefixesAtom,
  updateMobilePreferencesAtom,
} from "../../../state/preferences";
import { SettingsSection } from "./SettingsSection";

export function IgnoredCommandPrefixesSettings() {
  const prefixes = useAtomValue(ignoredCommandPrefixesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const edited = useRef(false);
  const value = prefixes.join("\n");

  return (
    <SettingsSection
      title="Top-level commands to ignore"
      trailing={
        prefixes.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reset top-level commands to ignore"
            onPress={() => {
              edited.current = false;
              savePreferences({ ignoredCommandPrefixes: [] });
            }}
          >
            <Text className="text-sm text-accent">Reset</Text>
          </Pressable>
        ) : null
      }
    >
      <View className="gap-2 px-4 py-3">
        <Text className="text-sm text-foreground-muted">
          Hide command prefixes in activity labels and previews. Enter one per line. Full command
          details stay available. This applies on this device.
        </Text>
        <AppTextInput
          key={value}
          accessibilityLabel="Top-level commands to ignore"
          defaultValue={value}
          placeholder="No commands ignored"
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          className="min-h-24 rounded-xl px-3 py-2 text-base text-foreground"
          onChangeText={() => {
            edited.current = true;
          }}
          onEndEditing={(event) => {
            const next = parseIgnoredCommandPrefixes(event.nativeEvent.text);
            if (edited.current && next.join("\n") !== value) {
              savePreferences({ ignoredCommandPrefixes: next });
            }
            edited.current = false;
          }}
        />
      </View>
    </SettingsSection>
  );
}
