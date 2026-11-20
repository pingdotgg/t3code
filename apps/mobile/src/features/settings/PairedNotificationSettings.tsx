import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState, type JSX } from "react";
import { Platform } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { runtime } from "../../lib/runtime";
import { uuidv4 } from "../../lib/uuid";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import {
  supportsPairedAndroidNotifications,
  supportsAndroidLiveUpdateSettings,
  openAndroidLiveUpdateSettings,
  configurePairedAndroidNotifications,
} from "../agent-awareness/androidNotifications";
import {
  enablePairedNotifications,
  pairedNotificationStatusesAtom,
  updatePairedNotificationRegistration,
} from "../agent-awareness/pairedNotifications";
import type { SavedRemoteConnection } from "../../lib/connection";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsRow } from "./components/SettingsRow";

export function PairedNotificationSettings(): JSX.Element | null {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomCommand(saveMobilePreferences, { reportFailure: false });
  const statuses = useAtomValue(pairedNotificationStatusesAtom);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  if (Platform.OS !== "android") return null;
  const supported = supportsPairedAndroidNotifications();
  const registrations = AsyncResult.isSuccess(preferences)
    ? (preferences.value.pairedNotifications ?? {})
    : {};
  const connections = Object.values(savedConnectionsById).filter(
    (connection) => !connection.relayManaged,
  );

  async function toggle(connection: SavedRemoteConnection, enabled: boolean): Promise<void> {
    if (pending.has(connection.environmentId)) return;
    setPending((current) => new Set([...current, connection.environmentId]));
    const registrationId = enabled
      ? uuidv4()
      : (registrations[connection.environmentId]?.registrationId ?? uuidv4());
    let preferenceSaved = false;
    try {
      if (enabled) await runtime.runPromise(enablePairedNotifications(connection, registrationId));
      await save({
        transform: (current) => ({
          pairedNotifications: {
            ...current.pairedNotifications,
            [connection.environmentId]: { registrationId, enabled },
          },
        }),
      });
      preferenceSaved = true;
      if (!enabled)
        await runtime.runPromise(
          updatePairedNotificationRegistration(connection, { registrationId, enabled }),
        );
    } catch (error) {
      if (enabled && !preferenceSaved) {
        configurePairedAndroidNotifications(
          Object.values(registrations)
            .filter((registration) => registration.enabled)
            .map((registration) => registration.registrationId),
          AsyncResult.isSuccess(preferences) && preferences.value.liveActivitiesEnabled !== false,
        );
        void runtime
          .runPromise(
            updatePairedNotificationRegistration(connection, { registrationId, enabled: false }),
          )
          .catch(() => undefined);
      }
      if (!enabled && preferenceSaved) {
        Dialog.alert(
          "Notifications are off on this phone",
          "Couldn't remove the server subscription yet. It will retry when this environment is reachable.",
        );
      } else {
        Dialog.alert(
          "Couldn't update notifications",
          error instanceof Error
            ? error.message
            : "Could not update this device's notification registration.",
        );
      }
    }
    setPending((current) => new Set([...current].filter((id) => id !== connection.environmentId)));
  }

  return (
    <SettingsSection title="Paired environments">
      <Text className="text-sm text-foreground-muted">
        Get rich agent alerts and ongoing activity directly from your servers, without T3 Connect.
        Notification content is encrypted for this phone before it reaches Google.
      </Text>
      {!supported ? (
        <Text className="text-sm text-foreground-muted">
          Install a newer Android build with Firebase configured to enable paired notifications.
        </Text>
      ) : null}
      {connections.length === 0 ? (
        <Text className="text-sm text-foreground-muted">
          Pair an environment to enable its notifications.
        </Text>
      ) : null}
      {connections.map((connection) => (
        <SettingsSwitchRow
          key={connection.environmentId}
          icon="bell.badge"
          label={connection.environmentLabel}
          subtitle={
            pending.has(connection.environmentId)
              ? "Updating…"
              : registrations[connection.environmentId]?.enabled
                ? (statuses[connection.environmentId]?.message ?? "Checking registration…")
                : "Off"
          }
          disabled={
            !supported ||
            (!connection.bearerToken && !registrations[connection.environmentId]?.enabled) ||
            pending.has(connection.environmentId) ||
            !AsyncResult.isSuccess(preferences)
          }
          value={registrations[connection.environmentId]?.enabled === true}
          onValueChange={(enabled) => {
            void toggle(connection, enabled);
          }}
        />
      ))}
      {supported && connections.length > 0 ? (
        <SettingsSwitchRow
          icon="bolt.circle"
          label="Ongoing Agent Activity"
          subtitle="Show activity cards for enabled environments. This device preference also applies to T3 Connect."
          disabled={!AsyncResult.isSuccess(preferences)}
          value={
            AsyncResult.isSuccess(preferences) && preferences.value.liveActivitiesEnabled !== false
          }
          onValueChange={(enabled) => {
            void save({ liveActivitiesEnabled: enabled }).catch(() => {
              Dialog.alert(
                "Couldn't update activity",
                "Try changing the activity preference again.",
              );
            });
          }}
        />
      ) : null}
      {supported && supportsAndroidLiveUpdateSettings() ? (
        <SettingsRow
          icon="bolt.circle"
          label="Live Update Settings"
          onPress={() => {
            void openAndroidLiveUpdateSettings().catch(() => {
              Dialog.alert(
                "Couldn't open Settings",
                "Open T3 Code's notification settings in Android Settings.",
              );
            });
          }}
        />
      ) : null}
    </SettingsSection>
  );
}
