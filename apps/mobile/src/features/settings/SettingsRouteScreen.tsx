import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useAuth, useUser } from "@clerk/expo";
import { useNavigation } from "@react-navigation/native";
import { Platform, View } from "react-native";
import { deriveProjectGroupLabel } from "@t3tools/client-runtime/state/project-grouping";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function SettingsRouteScreen() {
  const content = hasCloudPublicConfig() ? (
    <ConfiguredSettingsRouteScreen />
  ) : (
    <LocalSettingsRouteScreen />
  );

  return (
    <>
      <WorkspaceSidebarToolbar />
      <SettingsEnvironmentFilterHeader closeSettings />
      {Platform.OS === "android" ? (
        <SettingsScreen title="Settings" trailing={<AndroidSettingsEnvironmentFilter />}>
          {content}
        </SettingsScreen>
      ) : (
        content
      )}
    </>
  );
}

function ConfiguredSettingsRouteScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const accountLabel = !isLoaded
    ? "Checking"
    : !isSignedIn
      ? "Sign in"
      : (user?.primaryEmailAddress?.emailAddress ?? "Signed in");

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Connections">
          <SettingsRow
            icon="person.crop.circle"
            label="T3 Account"
            value={accountLabel}
            disabled={!isLoaded}
            onPress={() => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" })}
          />
          <SettingsRow
            icon="desktopcomputer"
            label="Environments"
            value={`${Object.keys(savedConnectionsById).length}`}
            valuePosition="trailing"
            target="SettingsEnvironments"
          />
          <SettingsRow icon="bell.badge" label="Notifications" target="SettingsNotifications" />
        </SettingsSection>

        <SettingsIndexSections />
      </ScrollView>
    </View>
  );
}

function LocalSettingsRouteScreen() {
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environmentCount = Object.keys(savedConnectionsById).length;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title="Connections">
          <SettingsRow
            icon="desktopcomputer"
            label="Environments"
            value={`${environmentCount}`}
            valuePosition="trailing"
            target="SettingsEnvironments"
          />
        </SettingsSection>

        <SettingsIndexSections />
      </ScrollView>
    </View>
  );
}

function ConfiguredSettingsRouteScreen() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const agentAwarenessPushAvailable = supportsAgentAwarenessPush();
  const agentAwarenessPlatform = resolveAgentAwarenessPlatformPresentation(Platform.OS);
  const agentAwarenessSubtitle =
    Platform.OS === "android" && !agentAwarenessPushAvailable
      ? "Install a newer app build to enable notifications"
      : agentAwarenessPlatform.subtitle;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { getToken, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>("checking");
  const [liveActivityStatus, setLiveActivityStatus] = useState<LiveActivityStatus>("checking");
  const deviceRegistered = useDeviceRegistered();
  const liveActivitiesPreferenceEnabled = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.liveActivitiesEnabled !== false
    : true;

  const connections = useMemo(() => Object.values(savedConnectionsById), [savedConnectionsById]);
  const environmentCount = connections.length;
  const accountLabel = useMemo(() => {
    if (!isLoaded) return "Checking";
    if (!isSignedIn) return "Sign in";
    return user?.primaryEmailAddress?.emailAddress ?? "Signed in";
  }, [isLoaded, isSignedIn, user?.primaryEmailAddress?.emailAddress]);

  const refreshNotifications = useCallback(async () => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") {
      setNotificationStatus("unsupported");
      return;
    }
    const result = await settlePromise(() => Notifications.getPermissionsAsync());
    if (result._tag === "Failure") {
      reportAtomCommandResult(result, { label: "notification permission refresh" });
      setNotificationStatus("disabled");
      return;
    }
    setNotificationStatus(result.value.granted ? "enabled" : "disabled");
  }, []);

  useEffect(() => {
    void refreshNotifications();
  }, [refreshNotifications]);

  useEffect(() => {
    if (!isLoaded) {
      setLiveActivityStatus("checking");
      return;
    }
    if (!isSignedIn) {
      setLiveActivityStatus("signed-out");
      return;
    }
    if (!AsyncResult.isSuccess(preferencesResult)) {
      if (AsyncResult.isFailure(preferencesResult)) {
        reportAtomCommandResult(preferencesResult, { label: "live activity preference load" });
        setLiveActivityStatus("enabled");
      } else {
        setLiveActivityStatus("checking");
      }
      return;
    }
    setLiveActivityStatus(
      preferencesResult.value.liveActivitiesEnabled === false ? "disabled" : "enabled",
    );
  }, [isLoaded, isSignedIn, preferencesResult]);

  const requestNotifications = useCallback(async () => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        requestAgentNotificationPermission.pipe(
          Effect.tap((permission) =>
            permission.type === "granted" ? refreshAgentAwarenessRegistration() : Effect.void,
          ),
        ),
      ),
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Notifications unavailable",
          error instanceof Error ? error.message : "Could not request notification permission.",
        );
      }
      return;
    }
    if (result.value.type === "granted") {
      setNotificationStatus("enabled");
      // Permission alone is not enough: the switch stays off until the relay
      // registration succeeds, so tell the user the truth about which happened.
      if (getAgentAwarenessRegistrationStatus() === "registered") {
        Alert.alert("Notifications enabled", "Agent notifications are enabled for this device.");
      } else {
        Alert.alert(
          "Couldn't finish enabling notifications",
          "Notification access was granted, but this device could not be registered with T3 Connect. Notifications will start once registration succeeds.",
        );
      }
      return;
    }
    if (result.value.type === "unsupported") {
      setNotificationStatus("unsupported");
      Alert.alert(
        "Notifications unavailable",
        "Agent notifications are unavailable on this platform.",
      );
      return;
    }
    setNotificationStatus("disabled");
    if (result.value.canAskAgain) {
      Alert.alert("Notifications disabled", "Notifications were not enabled.");
      return;
    }
    Alert.alert(
      "Notifications disabled",
      "Notifications were denied for this app. Open Settings to enable them.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
  }, []);

  const promptSignIn = useCallback(() => {
    Alert.alert(
      "Sign in to T3 Connect",
      "Live Activity updates require T3 Connect so relay can deliver updates to this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue",
          onPress: () => navigation.navigate("SettingsSheet", { screen: "SettingsAuth" }),
        },
      ],
    );
  }, [navigation]);

  const linkEnvironments = useCallback(async () => {
    if (!isSignedIn) {
      promptSignIn();
      return;
    }

    setLiveActivityStatus("linking");
    if (Platform.OS === "android") {
      const permission = await settleAsyncResult(() =>
        runtime.runPromiseExit(requestAgentNotificationPermission),
      );
      if (permission._tag === "Failure") {
        setLiveActivityStatus("disabled");
        const error = squashAtomCommandFailure(permission);
        Alert.alert(
          "Ongoing activity unavailable",
          error instanceof Error ? error.message : "Could not enable agent notifications.",
        );
        return;
      }
      if (permission.value.type !== "granted") {
        setLiveActivityStatus("disabled");
        Alert.alert(
          "Notification permission needed",
          "Enable notifications in system Settings to show ongoing agent activity.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Open Settings", onPress: () => void Linking.openSettings() },
          ],
        );
        return;
      }
      setNotificationStatus("enabled");
    }
    const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
    if (tokenResult._tag === "Failure") {
      setLiveActivityStatus("disabled");
      const error = squashAtomCommandFailure(tokenResult);
      Alert.alert(
        Platform.OS === "android" ? "Ongoing activity unavailable" : "Live Activities unavailable",
        error instanceof Error ? error.message : "Could not enable agent activity updates.",
      );
      return;
    }
    if (!tokenResult.value) {
      promptSignIn();
      setLiveActivityStatus("signed-out");
      return;
    }

    const updateResult = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        setLiveActivityUpdatesEnabled({
          enabled: true,
          previousEnabled: liveActivitiesPreferenceEnabled,
          clerkToken: tokenResult.value,
          connections,
        }),
      ),
    );
    if (updateResult._tag === "Failure") {
      setLiveActivityStatus("disabled");
      if (!isAtomCommandInterrupted(updateResult)) {
        const error = squashAtomCommandFailure(updateResult);
        Alert.alert(
          Platform.OS === "android"
            ? "Ongoing activity unavailable"
            : "Live Activities unavailable",
          error instanceof Error ? error.message : "Could not enable agent activity updates.",
        );
      }
      return;
    }

    savePreferences({ liveActivitiesEnabled: true });
    refreshManagedRelayEnvironments();
    setLiveActivityStatus("enabled");
    // The environment link can succeed while this device's own registration
    // (the push-to-start token the relay needs) has not — don't claim Live
    // Activities are live until the device is actually registered.
    if (getAgentAwarenessRegistrationStatus() === "registered") {
      Alert.alert(
        Platform.OS === "android" ? "Ongoing activity enabled" : "Live Activities enabled",
        environmentCount > 0
          ? `${environmentCount} environment${environmentCount === 1 ? "" : "s"} linked for agent activity updates.`
          : "Agent activity updates are enabled. Add an environment to start receiving updates.",
      );
    } else {
      Alert.alert(
        "Couldn't finish enabling activity updates",
        "This device could not be registered with T3 Connect, so activity updates won't appear yet. They'll start once registration succeeds.",
      );
    }
  }, [
    connections,
    environmentCount,
    getToken,
    isSignedIn,
    liveActivitiesPreferenceEnabled,
    promptSignIn,
    savePreferences,
  ]);

  const handleDeviceNotificationsChange = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        if (!isSignedIn) {
          promptSignIn();
          return;
        }
        void requestNotifications();
        return;
      }

      Alert.alert(
        "Disable notifications",
        "Open system Settings to disable notifications for T3 Code.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Open Settings", onPress: () => void Linking.openSettings() },
        ],
      );
    },
    [isSignedIn, promptSignIn, requestNotifications],
  );

  const handleLiveActivitiesChange = useCallback(
    (enabled: boolean) => {
      if (!enabled) {
        setLiveActivityStatus("disabled");
        void (async () => {
          let token: string | null = null;
          if (isSignedIn) {
            const tokenResult = await settlePromise(() =>
              getToken(resolveRelayClerkTokenOptions()),
            );
            if (tokenResult._tag === "Failure") {
              reportAtomCommandResult(tokenResult, {
                label: "live activity disable token lookup",
              });
              return;
            }
            token = tokenResult.value;
          }

          const updateResult = await settleAsyncResult(() =>
            runtime.runPromiseExit(
              setLiveActivityUpdatesEnabled({
                enabled: false,
                previousEnabled: liveActivitiesPreferenceEnabled,
                clerkToken: token,
                connections,
              }),
            ),
          );
          if (updateResult._tag === "Failure") {
            setLiveActivityStatus("enabled");
            reportAtomCommandResult(updateResult, {
              label: "live activity disable",
            });
            return;
          }
          savePreferences({ liveActivitiesEnabled: false });
          refreshManagedRelayEnvironments();
        })();
        return;
      }

      if (!isSignedIn) {
        promptSignIn();
        return;
      }

      void linkEnvironments();
    },
    [
      connections,
      getToken,
      isSignedIn,
      linkEnvironments,
      liveActivitiesPreferenceEnabled,
      promptSignIn,
      savePreferences,
    ],
  );

  const openAccount = useCallback(() => {
    if (!isLoaded) return;
    navigation.navigate("SettingsSheet", { screen: "SettingsAuth" });
  }, [isLoaded, navigation]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <View className="gap-3">
          <SettingsSection title="Account">
            <SettingsRow
              icon="person.crop.circle"
              label="T3 Account"
              value={accountLabel}
              onPress={openAccount}
            />
          </SettingsSection>
          <Text className="px-2 text-sm text-foreground-muted">
            T3 Code works locally without signing in. Cloud features are optional.
          </Text>
        </View>

        <SettingsSection title="Configuration">
          <SettingsRow
            icon="desktopcomputer"
            label="Environments"
            value={`${environmentCount}`}
            valuePosition="trailing"
            target="SettingsEnvironments"
          />
          <SettingsSwitchRow
            icon="bell.badge"
            label="Device Notifications"
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              notificationStatus === "checking" ||
              notificationStatus === "unsupported"
            }
            subtitle={agentAwarenessSubtitle}
            // Only reads as on when this device is actually registered with the
            // relay; otherwise notifications cannot be delivered regardless of
            // the local iOS permission.
            value={
              agentAwarenessPushAvailable && notificationStatus === "enabled" && deviceRegistered
            }
            onValueChange={handleDeviceNotificationsChange}
          />
          <SettingsSwitchRow
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              !isLoaded ||
              liveActivityStatus === "checking" ||
              liveActivityStatus === "linking"
            }
            icon="bolt.circle"
            label={
              Platform.OS === "android"
                ? supportsAndroidLiveUpdateSettings()
                  ? "Agent Live Updates"
                  : "Ongoing Agent Activity"
                : "Live Activity Updates"
            }
            subtitle={agentAwarenessSubtitle}
            // Same gate: a saved preference is meaningless until the device
            // registration the relay needs to push updates has succeeded.
            value={
              agentAwarenessPushAvailable &&
              (liveActivityStatus === "enabled" || liveActivityStatus === "linking") &&
              deviceRegistered
            }
            onValueChange={handleLiveActivitiesChange}
          />
          {supportsAndroidLiveUpdateSettings() ? (
            <SettingsRow
              icon="bolt.circle"
              label="Live Update Settings"
              onPress={() => {
                void openAndroidLiveUpdateSettings().catch(() => {
                  Alert.alert(
                    "Couldn't open Settings",
                    "Open Android Settings, select T3 Code, then enable Live Updates in Notifications.",
                  );
                });
              }}
            />
          ) : null}
        </SettingsSection>

        <GeneralSettingsSection />

        <SettingsSection title="Appearance">
          <SettingsRow icon="paintbrush" label="Appearance" target="SettingsAppearance" />
        </SettingsSection>

        <LegacySettingsSection />

        <ArchivedThreadsSettingsSection />

        <AppSettingsSection />
      </ScrollView>
    </View>
  );
}

function GeneralSettingsSection() {
  return (
    <SettingsSection title="General">
      <SettingsRow icon="folder" label="Project Grouping" target="SettingsProjectGrouping" />
      <SettingsRow icon="arrow.turn.left.up" label="Follow-ups" target="SettingsFollowUp" />
      {Platform.OS === "ios" ? (
        <SettingsRow icon="keyboard" label="Keyboard" target="SettingsKeyboard" />
      ) : null}
      <AutoSettleSettingsRows />
      <SettingsRow icon="chart.bar.xaxis" label="Usage" target="SettingsUsage" />
    </SettingsSection>
  );
}

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

/**
 * Mobile edits auto-settle defaults across connected, capable environments.
 * The first target supplies the displayed values. Applying them leaves each
 * environment's other defaults and overrides intact.
 */
function AutoSettleSettingsRows() {
  const { environments } = useEnvironments();
  const [pendingWrites, setPendingWrites] = useState(0);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "server settings update",
    reportFailure: true,
  });

  const syncTargets = environments.filter(supportsSharedSettingsSync);
  const reference = syncTargets[0] ?? null;
  const referenceSettings = reference?.serverConfig?.settings ?? null;

  if (reference === null || referenceSettings === null) {
    return null;
  }

  const writeToAll = (patch: Partial<AutoSettleSettings>) => {
    setPendingWrites((count) => count + 1);
    void Promise.allSettled(
      syncTargets.map((environment) =>
        updateSettings({ environmentId: environment.environmentId, input: { patch } }),
      ),
    ).finally(() => setPendingWrites((count) => count - 1));
  };

  const { patch: autoSettlePatch, mismatches } = planAutoSettleSettingsSync(
    { environmentId: reference.environmentId, settings: referenceSettings },
    syncTargets.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      settings: environment.serverConfig?.settings ?? null,
    })),
  );

  const afterDays = referenceSettings.sidebarAutoSettleAfterDays;

  return (
    <>
      <SettingsSection title="Interface">
        <SettingsRow icon="paintbrush" label="Appearance" target="SettingsAppearance" />
        {Platform.OS === "ios" ? (
          <SettingsRow icon="keyboard" label="Keyboard" target="SettingsKeyboard" />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Projects & threads">
        {selectedProjectKey !== null ? (
          <SettingsRow
            icon="folder"
            label="Overview"
            value={projectLabel}
            target="SettingsProjectOverview"
          />
        ) : null}
        <SettingsRow icon="folder" label="Organization" target="SettingsOrganization" />
        <SettingsRow icon="text.bubble" label="Thread behavior" target="SettingsThreads" />
        <SettingsRow icon="archivebox" label="Archived Threads" target="SettingsArchive" />
      </SettingsSection>

      <SettingsSection title="Server settings">
        <SettingsRow
          icon="text.bubble"
          label="New threads"
          target="SettingsEnvironmentNewThreads"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="arrow.triangle.branch"
          label="Source control"
          target="SettingsEnvironmentSourceControl"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="text.alignleft"
          label="Agent behavior"
          target="SettingsEnvironmentAgentBehavior"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="arrow.clockwise"
          label="Maintenance"
          target="SettingsEnvironmentMaintenance"
          disabled={noServerTargets}
        />
      </SettingsSection>

      <SettingsSection title="App">
        <SettingsRow icon="chart.bar.xaxis" label="Usage" target="SettingsUsage" />
        <SettingsRow icon="info.circle" label="About T3 Code" target="SettingsAbout" />
      </SettingsSection>
    </>
  );
}
