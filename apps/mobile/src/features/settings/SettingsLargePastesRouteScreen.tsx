import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { pastedTextThresholdLabel } from "@t3tools/client-runtime/text-paste";
import {
  DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD,
  type PastedTextAttachmentThreshold,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSection } from "./components/SettingsSection";

const THRESHOLD_OPTIONS: ReadonlyArray<{
  readonly threshold: PastedTextAttachmentThreshold;
  readonly description: string;
}> = [
  { threshold: 1_000, description: "Most logs, stack traces, and code snippets become files." },
  { threshold: 5_000, description: "Long logs and documents become files; snippets stay as text." },
  { threshold: 32_768, description: "Default. Only very large pastes become files." },
];

const PASTE_AS_TEXT_SHORTCUT = Platform.OS === "ios" ? "Command + Shift + V" : "Ctrl + Shift + V";

export function SettingsLargePastesRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selectedThreshold = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.pastedTextAttachmentThreshold ??
      DEFAULT_PASTED_TEXT_ATTACHMENT_THRESHOLD)
    : null;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Large pastes" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
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
          Sizes count bytes, so non-Latin text and emoji become files with fewer characters. Shorter
          pastes go into the message as text. With a hardware keyboard, press{" "}
          {PASTE_AS_TEXT_SHORTCUT} to paste a long block as text instead.
        </Text>
      </ScrollView>
    </View>
  );
}
