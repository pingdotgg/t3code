import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Platform } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { clearAppleIntentsIndex, disableAppleIntents } from "./appleIntentsRuntime";
import { isAppleIntentsSupported } from "./nativeBridge";

export function AppleIntentsSettingsSection() {
  const gt = useGT();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const [clearing, setClearing] = useState(false);

  if (Platform.OS !== "ios" || !isAppleIntentsSupported()) {
    return null;
  }

  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {};
  const enabled = preferences.appleIntentsEnabled ?? true;
  const indexMessagePreviews = preferences.appleIntentsIndexMessagePreviews ?? false;

  const reportClearFailure = () =>
    Dialog.alert(
      gt("Could not clear index"),
      gt("Indexed threads may still appear in Spotlight. Try clearing it again."),
    );

  const handleClearIndex = () => {
    if (clearing) return;
    setClearing(true);
    void clearAppleIntentsIndex().then(
      () => {
        setClearing(false);
        Dialog.alert(
          gt("Siri & Spotlight index cleared"),
          gt("Indexed T3 Code projects and threads were removed from this device."),
        );
      },
      () => {
        setClearing(false);
        reportClearFailure();
      },
    );
  };

  return (
    <SettingsSection title={gt("Siri & Spotlight")}>
      <SettingsSwitchRow
        label={gt("Index threads & projects for Siri")}
        subtitle={gt(
          "Let Siri, Shortcuts, and Spotlight search your active projects and threads and run T3 Code actions.",
        )}
        value={enabled}
        disabled={!preferencesReady}
        onValueChange={(next) => {
          if (next) {
            void savePreferences({ appleIntentsEnabled: true });
            return;
          }
          // Save the opt-out only once the index is gone, so a cut-short clear stays visible.
          void disableAppleIntents(() => savePreferences({ appleIntentsEnabled: false })).catch(
            reportClearFailure,
          );
        }}
      />
      <SettingsSwitchRow
        label={gt("Include message previews")}
        subtitle={gt(
          "Index a short sanitized summary of each thread’s latest message in Spotlight.",
        )}
        value={enabled && indexMessagePreviews}
        disabled={!preferencesReady || !enabled}
        onValueChange={(next) => {
          void savePreferences({ appleIntentsIndexMessagePreviews: next });
        }}
      />
      <SettingsRow
        icon="trash"
        label={gt("Clear Siri & Spotlight index")}
        value={clearing ? gt("Clearing…") : undefined}
        disabled={clearing}
        onPress={() => {
          void handleClearIndex();
        }}
      />
    </SettingsSection>
  );
}
