import { useAtomValue } from "@effect/atom-react";
import { msg, useGT, useMessages } from "gt-react-native";
import { AsyncResult } from "effect/reactivity";
import { Platform } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { DEFAULT_APP_LOCK_GRACE_PERIOD_MS, type AppLockGracePeriodMs } from "../../lib/appLock";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { authenticateAppLock } from "./appLockRuntime";

const GRACE_PERIOD_OPTIONS: ReadonlyArray<{
  readonly gracePeriodMs: AppLockGracePeriodMs;
  readonly label: string;
}> = [
  { gracePeriodMs: 0, label: msg("Immediately") },
  { gracePeriodMs: 60_000, label: msg("After 1 minute") },
  { gracePeriodMs: 300_000, label: msg("After 5 minutes") },
  { gracePeriodMs: 900_000, label: msg("After 15 minutes") },
  { gracePeriodMs: 3_600_000, label: msg("After 1 hour") },
];

export function AppLockSettingsSection() {
  const gt = useGT();
  const m = useMessages();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;
  const enabled = preferences?.appLockEnabled === true;
  const gracePeriodMs = preferences?.appLockGracePeriodMs ?? DEFAULT_APP_LOCK_GRACE_PERIOD_MS;

  // Turning it off asks too, so someone handed the unlocked phone can't keep access for later.
  const setEnabled = async (value: boolean) => {
    const result = await authenticateAppLock(
      value ? gt("Turn on app lock") : gt("Turn off app lock"),
    );
    if (result === "success" || (!value && result === "no-screen-lock")) {
      void savePreferences({ appLockEnabled: value });
      return;
    }
    if (result === "no-screen-lock") {
      Dialog.alert(
        gt("Set up a screen lock first"),
        Platform.OS === "ios"
          ? gt("App lock uses Face ID, Touch ID or your passcode. Add a passcode in Settings.")
          : gt(
              "App lock uses your fingerprint, face or screen lock. Add a screen lock in Settings.",
            ),
      );
    }
  };

  return (
    <>
      <SettingsSection title={gt("Security")}>
        <ListToggleRow
          label={gt("App lock")}
          description={
            Platform.OS === "ios"
              ? gt("Ask for Face ID, Touch ID or your passcode to open T3 Code.")
              : gt("Ask for your fingerprint, face or screen lock to open T3 Code.")
          }
          value={enabled}
          disabled={!preferencesReady}
          onValueChange={(value) => void setEnabled(value)}
        />
      </SettingsSection>
      {enabled ? (
        <>
          <SettingsSection title={gt("Ask again after")}>
            {GRACE_PERIOD_OPTIONS.map((option, index) => (
              <ListChoiceRow
                key={option.gracePeriodMs}
                label={m(option.label)}
                selected={gracePeriodMs === option.gracePeriodMs}
                separated={index > 0}
                disabled={!preferencesReady}
                onPress={() => {
                  void savePreferences({ appLockGracePeriodMs: option.gracePeriodMs });
                }}
              />
            ))}
          </SettingsSection>
          <Text className="px-2 text-sm text-foreground-muted">
            {gt(
              "Only time spent away from T3 Code counts. It always asks again after the app restarts.",
            )}
          </Text>
        </>
      ) : null}
    </>
  );
}
