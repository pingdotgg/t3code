import { useAtom } from "@effect/atom-react";
import { msg, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { Notice } from "../../components/ui/Notice";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import {
  APP_LOCK_TIMEOUTS_SECONDS,
  APP_LOCK_UNAVAILABLE_CODE,
  appLockStatusAtom,
  configureAppLock,
  readAppLockStatus,
  type AppLockBiometry,
} from "../app-lock/appLock";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const PRODUCT = "PseudoCode";

const TIMEOUT_LABELS: Record<(typeof APP_LOCK_TIMEOUTS_SECONDS)[number], string> = {
  0: msg("Immediately", { $context: "app lock timeout" }),
  60: msg("After 1 minute"),
  300: msg("After 5 minutes"),
  900: msg("After 15 minutes"),
  3600: msg("After 1 hour"),
};

const UNLOCK_DESCRIPTIONS: Record<AppLockBiometry, string> = {
  faceID: msg("Require Face ID or your passcode to open {product}."),
  touchID: msg("Require Touch ID or your passcode to open {product}."),
  opticID: msg("Require Optic ID or your passcode to open {product}."),
  biometric: msg("Require your fingerprint, face, or screen lock to open {product}."),
  none:
    Platform.OS === "android"
      ? msg("Require your screen lock to open {product}.")
      : msg("Require your passcode to open {product}."),
};

export function SettingsAppLockRouteScreen() {
  const gt = useGT();
  const m = useMessages();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useAtom(appLockStatusAtom);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (enabled: boolean, timeoutSeconds: number) => {
    setBusy(true);
    setError(null);
    await configureAppLock(enabled, timeoutSeconds).catch((cause: { code?: unknown }) => {
      setError(
        cause.code === APP_LOCK_UNAVAILABLE_CODE
          ? unavailableMessage()
          : gt("App Lock could not be changed."),
      );
    });
    const next = await readAppLockStatus().catch(() => null);
    if (next) setStatus(next);
    setBusy(false);
  };

  const unavailableMessage = () =>
    Platform.OS === "android"
      ? gt("Set a screen lock in system settings to use App Lock.")
      : gt("Set a passcode in iOS Settings to use App Lock.");

  const enabled = status?.enabled ?? false;
  const timeoutSeconds = status?.timeoutSeconds ?? 60;
  const outsideContent =
    Platform.OS === "ios"
      ? gt("Notifications, widgets, and Live Activities still show their content while locked.")
      : gt("Notifications and widgets still show their content while locked.");

  return (
    <SettingsScreen title={gt("App Lock")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {status && !status.available && !status.enabled ? (
          <Notice icon="lock" message={unavailableMessage()} />
        ) : null}
        {error ? <Notice tone="danger" icon="exclamationmark.triangle" message={error} /> : null}
        <SettingsSection>
          <SettingsSwitchRow
            icon="lock"
            label={gt("App Lock")}
            subtitle={m(UNLOCK_DESCRIPTIONS[status?.biometry ?? "none"], { product: PRODUCT })}
            value={enabled}
            disabled={!status || busy || (!status.available && !enabled)}
            onValueChange={(value) => void apply(value, timeoutSeconds)}
          />
        </SettingsSection>
        {enabled ? (
          <SettingsSection title={gt("Lock after leaving the app")}>
            {APP_LOCK_TIMEOUTS_SECONDS.map((seconds, index) => (
              <ListChoiceRow
                key={seconds}
                label={m(TIMEOUT_LABELS[seconds])}
                selected={timeoutSeconds === seconds}
                separated={index > 0}
                disabled={busy}
                onPress={() => {
                  if (seconds !== timeoutSeconds) void apply(true, seconds);
                }}
              />
            ))}
          </SettingsSection>
        ) : null}
        <Text className="px-2 text-sm text-foreground-muted">
          {gt(
            "{product} also locks after the device restarts. Turning App Lock off or choosing a longer time asks you to unlock first.",
            { product: PRODUCT },
          )}
        </Text>
        <Text className="px-2 text-sm text-foreground-muted">{outsideContent}</Text>
      </ScrollView>
    </SettingsScreen>
  );
}
