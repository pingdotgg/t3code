import * as Dialog from "../../components/ui/Dialog";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "./components/SettingsSection";
import {
  buildRestoreDeviceDefaultsPatch,
  getChangedDevicePreferenceLabels,
} from "./device-defaults";

function confirmRestoreDeviceDefaults(
  changedLabels: readonly string[],
  save: (patch: ReturnType<typeof buildRestoreDeviceDefaultsPatch>) => void,
) {
  const message =
    changedLabels.length <= 8
      ? `This will reset: ${changedLabels.join(", ")}.`
      : `This will reset ${changedLabels.length} settings: ${changedLabels.slice(0, 8).join(", ")}, and ${changedLabels.length - 8} more.`;
  Dialog.confirm({
    title: "Restore default settings?",
    message: `${message}\n\nConnections, credentials, account data, and cached threads stay intact.`,
    confirmText: "Restore Defaults",
    destructive: true,
    onConfirm: () => save(buildRestoreDeviceDefaultsPatch()),
  });
}

export function RestoreDeviceDefaultsSection() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value
    : undefined;
  const changedLabels = preferences ? getChangedDevicePreferenceLabels(preferences) : [];
  const ready = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;

  const restore = () => {
    if (!ready || changedLabels.length === 0) return;
    confirmRestoreDeviceDefaults(changedLabels, savePreferences);
  };

  return (
    <View className="gap-3" style={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}>
      <SettingsSection title="Device">
        <SettingsActionRow
          icon="arrow.uturn.backward"
          label="Restore device defaults"
          description={
            changedLabels.length > 0
              ? `${changedLabels.length} setting${changedLabels.length === 1 ? "" : "s"} changed`
              : "All device settings are at their defaults"
          }
          tone="danger"
          disabled={!ready || changedLabels.length === 0}
          onPress={restore}
        />
      </SettingsSection>
      <Text className="px-2 text-sm leading-normal text-foreground-muted">
        Resets appearance, navigation, grouping, follow-ups, and other device preferences to their
        defaults. Server settings on connected environments are unchanged.
      </Text>
    </View>
  );
}

export function RestoreDeviceDefaultsInlineRow() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value
    : undefined;
  const changedLabels = preferences ? getChangedDevicePreferenceLabels(preferences) : [];
  // Restoring unmounts this row; there is no post-save state to show.
  const ready = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  if (!ready || changedLabels.length === 0) return null;

  const restore = () => confirmRestoreDeviceDefaults(changedLabels, savePreferences);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Restore device defaults, ${changedLabels.length} settings changed`}
      accessibilityHint="Resets device preferences to their defaults"
      onPress={restore}
      className="flex-row items-center gap-3 rounded-full bg-danger px-4 py-2 active:opacity-70"
    >
      <SymbolView
        name="arrow.uturn.backward"
        size={16}
        tintColorClassName="accent-danger-foreground"
        type="monochrome"
        weight="regular"
      />
      <Text className="text-sm font-t3-medium text-danger-foreground">Restore defaults</Text>
    </Pressable>
  );
}
