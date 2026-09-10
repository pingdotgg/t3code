import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  getMediaLibraryPermissionsAsync,
  type MediaLibraryPermissionResponse,
} from "expo-image-picker";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Linking, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  createRecentPhotosAccessOperations,
  requestRecentPhotosAccess,
} from "./recentPhotosAccess";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsRow } from "./components/SettingsRow";

export function RecentPhotosSettingsSection() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [permission, setPermission] = useState<MediaLibraryPermissionResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [operations] = useState(createRecentPhotosAccessOperations);
  const ready = AsyncResult.isSuccess(preferences);
  const enabled = ready && preferences.value.recentPhotosEnabled === true;

  const refresh = useCallback(
    () =>
      operations.run(
        getMediaLibraryPermissionsAsync,
        (access) => {
          setPermission(access);
          if (!access.granted) savePreferences({ recentPhotosEnabled: false });
        },
        () => setPermission(null),
      ),
    [operations, savePreferences],
  );

  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && !inFlight.current) void refresh();
    });
    return () => {
      subscription.remove();
      operations.invalidate();
    };
  }, [operations, refresh]);

  const toggle = async (value: boolean) => {
    if (!ready || inFlight.current) return;
    if (!value) {
      operations.invalidate();
      savePreferences({ recentPhotosEnabled: false });
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      await operations.run(
        requestRecentPhotosAccess,
        (access) => {
          setPermission(access);
          savePreferences({ recentPhotosEnabled: access.granted });
        },
        () => Alert.alert("Couldn't check photo access", "Try again in a moment."),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const blocked = permission !== null && !permission.granted && !permission.canAskAgain;
  return (
    <View className="gap-3">
      <SettingsSection title="Attachments">
        <SettingsSwitchRow
          icon="photo"
          label="Photo quick picker"
          subtitle="Hold + to choose a photo"
          subtitleNumberOfLines={1}
          value={enabled && permission?.granted === true}
          disabled={!ready || busy || permission === null || blocked}
          onValueChange={(value) => void toggle(value)}
        />
        {blocked ? (
          <SettingsRow
            icon="gearshape"
            label="Open iOS Settings"
            onPress={() =>
              void Linking.openSettings().catch(() =>
                Alert.alert(
                  "Couldn't open Settings",
                  "Open iOS Settings, select T3 Code, then allow Photos access.",
                ),
              )
            }
          />
        ) : null}
        {permission === null ? (
          <SettingsRow
            icon="arrow.clockwise"
            label="Check photo access"
            onPress={() => void refresh()}
          />
        ) : null}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        {blocked
          ? "Photo access is disabled. Allow Photos access in iOS Settings to enable the picker."
          : permission?.accessPrivileges === "limited"
            ? "Only photos you've allowed appear in the picker."
            : "Requires photo-library access to show your four most recent photos."}
      </Text>
    </View>
  );
}
