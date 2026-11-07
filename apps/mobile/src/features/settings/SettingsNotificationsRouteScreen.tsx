import * as Dialog from "../../components/ui/Dialog";
import {
  AuthRelayWriteScope,
  managedCapabilityDenial,
  type EnvironmentId,
} from "@t3tools/contracts";
import { readEnvironmentScope } from "../../state/session";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAuth } from "@clerk/expo";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Notifications from "expo-notifications";
import { useNavigation } from "@react-navigation/native";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState, useSyncExternalStore } from "react";
import { Linking, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import {
  isAtomCommandInterrupted,
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { supportsAgentAwarenessPush } from "../agent-awareness/capabilities";
import {
  openAndroidLiveUpdateSettings,
  supportsAndroidLiveUpdateSettings,
} from "../agent-awareness/androidNotifications";
import { setLiveActivityUpdatesEnabled } from "../agent-awareness/liveActivityPreferences";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import {
  getAgentAwarenessRegistrationStatus,
  refreshAgentAwarenessRegistration,
  subscribeAgentAwarenessRegistrationStatus,
} from "../agent-awareness/remoteRegistration";
import { refreshManagedRelayEnvironments } from "../cloud/managedRelayState";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import { runtime } from "../../lib/runtime";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";
import { resolveAgentAwarenessPlatformPresentation } from "./SettingsRouteScreen.logic";

/**
 * A policy that turns Connect off refuses relay links and preferences, which would fail the
 * whole batch, so those environments are skipped like ones this session cannot configure.
 */
function canLinkEnvironmentToConnect(environmentId: EnvironmentId) {
  const policy = appAtomRegistry.get(
    serverEnvironment.configValueAtom(environmentId),
  )?.managedPolicy;
  return (
    readEnvironmentScope(environmentId, AuthRelayWriteScope) &&
    managedCapabilityDenial(policy, "connect") === undefined
  );
}

type NotificationStatus = "checking" | "enabled" | "disabled" | "unsupported";
type LiveActivityStatus = "checking" | "enabled" | "disabled" | "signed-out" | "linking";
type AgentActivityDeliveryMode = "off" | "banners" | "live";

const notificationStatusAtom = makePermissionStatusAtom<NotificationStatus>({
  label: "mobile:notification-permission",
  initial: "checking",
  read: async () => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") return "unsupported";
    const result = await settlePromise(() => Notifications.getPermissionsAsync());
    if (result._tag === "Failure") {
      reportAtomCommandResult(result, { label: "notification permission refresh" });
      return "disabled";
    }
    return result.value.granted ? "enabled" : "disabled";
  },
});

type LiveActivityBasis = {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean | undefined;
  readonly preferencesResult: unknown;
};

function liveActivityStatusFrom(
  isLoaded: boolean,
  isSignedIn: boolean | undefined,
  preferencesResult: AsyncResult.AsyncResult<{ readonly liveActivitiesEnabled?: boolean }, unknown>,
): LiveActivityStatus {
  if (!isLoaded) return "checking";
  if (!isSignedIn) return "signed-out";
  if (AsyncResult.isFailure(preferencesResult)) return "enabled";
  if (!AsyncResult.isSuccess(preferencesResult)) return "checking";
  return preferencesResult.value.liveActivitiesEnabled === false ? "disabled" : "enabled";
}

function useDeviceRegistered(): boolean {
  const status = useSyncExternalStore(
    subscribeAgentAwarenessRegistrationStatus,
    getAgentAwarenessRegistrationStatus,
    () => "unknown" as const,
  );
  return status === "registered";
}

function resolveDeliveryMode(input: {
  readonly pushAvailable: boolean;
  readonly notificationStatus: NotificationStatus;
  readonly deviceRegistered: boolean;
  readonly liveActivityStatus: LiveActivityStatus;
}): AgentActivityDeliveryMode {
  if (
    !input.pushAvailable ||
    input.notificationStatus === "disabled" ||
    input.notificationStatus === "unsupported" ||
    !input.deviceRegistered
  ) {
    return "off";
  }
  if (input.liveActivityStatus === "enabled" || input.liveActivityStatus === "linking") {
    return "live";
  }
  return "banners";
}

function liveActivityOptionCopy(): { readonly label: string; readonly description: string } {
  if (Platform.OS === "android") {
    return supportsAndroidLiveUpdateSettings()
      ? {
          label: "Live Updates",
          description:
            "Ongoing agent work as Live Updates, plus banners when an agent needs you or finishes.",
        }
      : {
          label: "Ongoing activity",
          description:
            "Ongoing agent work as a persistent notification, plus banners when an agent needs you or finishes.",
        };
  }
  return {
    label: "Live Activities",
    description:
      "Ongoing work on the Lock Screen and Dynamic Island, plus banners when an agent needs you or finishes.",
  };
}

export function SettingsNotificationsRouteScreen() {
  if (!hasCloudPublicConfig()) {
    return (
      <SettingsScreen title="Notifications">
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-5 pt-4"
        >
          <Text className="text-base text-foreground-muted">
            Notifications require T3 Connect in this app build.
          </Text>
        </ScrollView>
      </SettingsScreen>
    );
  }

  return <ConfiguredSettingsNotificationsRouteScreen />;
}

function ConfiguredSettingsNotificationsRouteScreen() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const agentAwarenessPushAvailable = supportsAgentAwarenessPush();
  const agentAwarenessPlatform = resolveAgentAwarenessPlatformPresentation(Platform.OS);
  const agentAwarenessUnavailableSubtitle =
    Platform.OS === "android" && !agentAwarenessPushAvailable
      ? "Install a newer app build to enable notifications"
      : agentAwarenessPlatform.subtitle;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { getToken, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { savedConnectionsById } = useSavedRemoteConnections();
  const notificationStatus = useAtomValue(notificationStatusAtom);
  const setNotificationStatus = useAtomSet(notificationStatusAtom);
  // A write in progress or a failed one shows its own status until the auth or
  // preference state it was based on changes.
  const [liveActivityOverride, setLiveActivityOverride] = useState<{
    readonly status: LiveActivityStatus;
    readonly basis: LiveActivityBasis;
  } | null>(null);
  const liveActivityBasis: LiveActivityBasis = { isLoaded, isSignedIn, preferencesResult };
  const liveActivityStatus =
    liveActivityOverride !== null &&
    liveActivityOverride.basis.isLoaded === isLoaded &&
    liveActivityOverride.basis.isSignedIn === isSignedIn &&
    liveActivityOverride.basis.preferencesResult === preferencesResult
      ? liveActivityOverride.status
      : liveActivityStatusFrom(isLoaded, isSignedIn, preferencesResult);
  const setLiveActivityStatus = (status: LiveActivityStatus) =>
    setLiveActivityOverride({ status, basis: liveActivityBasis });
  const liveActivityWriteInFlight = useRef(false);
  const deviceRegistered = useDeviceRegistered();
  const liveActivitiesPreferenceEnabled = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.liveActivitiesEnabled !== false
    : true;
  const canClearLiveActivitiesPreference =
    AsyncResult.isSuccess(preferencesResult) &&
    preferencesResult.value.liveActivitiesEnabled !== false;
  const selectedMode = resolveDeliveryMode({
    pushAvailable: agentAwarenessPushAvailable,
    notificationStatus,
    deviceRegistered,
    liveActivityStatus,
  });
  const liveOption = liveActivityOptionCopy();
  const deliveryOptions: ReadonlyArray<{
    readonly mode: AgentActivityDeliveryMode;
    readonly label: string;
    readonly description: string;
  }> = [
    {
      mode: "off",
      label: "Off",
      description: "No agent alerts on this phone.",
    },
    {
      mode: "banners",
      label: "Banners",
      description: "Notification banners for approvals, input requests, and finished runs.",
    },
    {
      mode: "live",
      label: liveOption.label,
      description: liveOption.description,
    },
  ];

  const connections = Object.values(savedConnectionsById);
  const environmentCount = connections.length;
  const choicesDisabled =
    !agentAwarenessPlatform.supported ||
    !agentAwarenessPushAvailable ||
    notificationStatus === "checking" ||
    notificationStatus === "unsupported" ||
    !isLoaded ||
    liveActivityStatus === "checking" ||
    liveActivityStatus === "linking";

  const promptSignIn = () => {
    Dialog.alert(
      "Sign in to T3 Connect",
      "Agent activity alerts require T3 Connect so relay can deliver updates to this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue",
          onPress: () => navigation.navigate("SettingsAuth"),
        },
      ],
    );
  };

  const ensureNotificationPermission = async (): Promise<boolean> => {
    if (notificationStatus === "enabled") {
      if (getAgentAwarenessRegistrationStatus() === "registered") {
        return true;
      }
      const refreshResult = await settleAsyncResult(() =>
        runtime.runPromiseExit(refreshAgentAwarenessRegistration()),
      );
      if (refreshResult._tag === "Failure") {
        if (!isAtomCommandInterrupted(refreshResult)) {
          Dialog.alert(
            "Couldn't finish enabling notifications",
            "Notification access is granted, but this device could not be registered with T3 Connect. Try again once you are online.",
          );
        }
        return false;
      }
      if (getAgentAwarenessRegistrationStatus() !== "registered") {
        Dialog.alert(
          "Couldn't finish enabling notifications",
          "Notification access is granted, but this device could not be registered with T3 Connect. Alerts will start once registration succeeds.",
        );
        return false;
      }
      return true;
    }
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
        Dialog.alert(
          "Notifications unavailable",
          error instanceof Error ? error.message : "Could not request notification permission.",
        );
      }
      return false;
    }
    if (result.value.type === "granted") {
      setNotificationStatus("enabled");
      if (getAgentAwarenessRegistrationStatus() !== "registered") {
        Dialog.alert(
          "Couldn't finish enabling notifications",
          "Notification access was granted, but this device could not be registered with T3 Connect. Alerts will start once registration succeeds.",
        );
        return false;
      }
      return true;
    }
    if (result.value.type === "unsupported") {
      setNotificationStatus("unsupported");
      Dialog.alert(
        "Notifications unavailable",
        "Agent notifications are unavailable on this platform.",
      );
      return false;
    }
    setNotificationStatus("disabled");
    if (result.value.canAskAgain) {
      Dialog.alert("Notifications disabled", "Notifications were not enabled.");
      return false;
    }
    Dialog.alert(
      "Notifications disabled",
      "Notifications were denied for this app. Open Settings to enable them.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
    return false;
  };

  async function disableLiveActivities() {
    let token: string | null = null;
    if (isSignedIn) {
      const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
      if (tokenResult._tag === "Failure") {
        setLiveActivityStatus("enabled");
        reportAtomCommandResult(tokenResult, {
          label: "live activity disable token lookup",
        });
        return false;
      }
      token = tokenResult.value;
    }

    const updateResult = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        setLiveActivityUpdatesEnabled({
          canConfigureEnvironment: canLinkEnvironmentToConnect,
          enabled: false,
          previousEnabled: liveActivitiesPreferenceEnabled,
          clerkToken: token,
          connections,
        }),
      ),
    );
    if (updateResult._tag === "Failure") {
      setLiveActivityStatus(isSignedIn ? "enabled" : "signed-out");
      reportAtomCommandResult(updateResult, {
        label: "live activity disable",
      });
      return false;
    }
    savePreferences({ liveActivitiesEnabled: false });
    refreshManagedRelayEnvironments();
    setLiveActivityStatus("disabled");
    return true;
  }

  async function enableLiveActivities(): Promise<boolean> {
    if (!isSignedIn) {
      promptSignIn();
      return false;
    }

    setLiveActivityStatus("linking");
    if (Platform.OS === "android") {
      const permitted = await ensureNotificationPermission();
      if (!permitted) {
        setLiveActivityStatus("disabled");
        return false;
      }
    }
    const tokenResult = await settlePromise(() => getToken(resolveRelayClerkTokenOptions()));
    if (tokenResult._tag === "Failure") {
      setLiveActivityStatus("disabled");
      const error = squashAtomCommandFailure(tokenResult);
      Dialog.alert(
        Platform.OS === "android" ? "Ongoing activity unavailable" : "Live Activities unavailable",
        error instanceof Error ? error.message : "Could not enable agent activity updates.",
      );
      return false;
    }
    if (!tokenResult.value) {
      promptSignIn();
      setLiveActivityStatus("signed-out");
      return false;
    }

    const updateResult = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        setLiveActivityUpdatesEnabled({
          canConfigureEnvironment: canLinkEnvironmentToConnect,
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
        Dialog.alert(
          Platform.OS === "android"
            ? "Ongoing activity unavailable"
            : "Live Activities unavailable",
          error instanceof Error ? error.message : "Could not enable agent activity updates.",
        );
      }
      return false;
    }

    savePreferences({ liveActivitiesEnabled: true });
    refreshManagedRelayEnvironments();
    setLiveActivityStatus("enabled");
    if (getAgentAwarenessRegistrationStatus() !== "registered") {
      Dialog.alert(
        "Couldn't finish enabling activity updates",
        "This device could not be registered with T3 Connect, so activity updates won't appear yet. They'll start once registration succeeds.",
      );
      return false;
    }
    if (environmentCount === 0) {
      Dialog.alert(
        Platform.OS === "android" ? "Ongoing activity enabled" : "Live Activities enabled",
        "Add an environment to start receiving updates.",
      );
    }
    return true;
  }

  const selectDeliveryMode = async (mode: AgentActivityDeliveryMode) => {
    if (
      choicesDisabled ||
      (mode === selectedMode && !(mode === "off" && canClearLiveActivitiesPreference)) ||
      liveActivityWriteInFlight.current
    ) {
      return;
    }

    if (mode === "off") {
      liveActivityWriteInFlight.current = true;
      setLiveActivityStatus("linking");
      if (liveActivitiesPreferenceEnabled) {
        await disableLiveActivities();
      } else {
        setLiveActivityStatus(isSignedIn ? "disabled" : "signed-out");
      }
      liveActivityWriteInFlight.current = false;
      Dialog.alert(
        "Turn off agent alerts",
        "Open system Settings to disable notifications for T3 Code. Until then, banner delivery stays available if permission is still granted.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Open Settings", onPress: () => void Linking.openSettings() },
        ],
      );
      return;
    }

    if (!isSignedIn) {
      promptSignIn();
      return;
    }

    liveActivityWriteInFlight.current = true;
    if (mode === "banners") {
      setLiveActivityStatus("linking");
      const permitted = await ensureNotificationPermission();
      if (!permitted) {
        setLiveActivityStatus(
          liveActivitiesPreferenceEnabled ? (isSignedIn ? "enabled" : "signed-out") : "disabled",
        );
        liveActivityWriteInFlight.current = false;
        return;
      }
      if (liveActivitiesPreferenceEnabled) {
        await disableLiveActivities();
      } else {
        setLiveActivityStatus("disabled");
      }
      liveActivityWriteInFlight.current = false;
      return;
    }

    const permitted = await ensureNotificationPermission();
    if (!permitted) {
      liveActivityWriteInFlight.current = false;
      return;
    }
    await enableLiveActivities();
    liveActivityWriteInFlight.current = false;
  };

  return (
    <SettingsScreen title="Notifications">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection
          title="Agent activity"
          footer={
            agentAwarenessUnavailableSubtitle ??
            "Pick one delivery style. Live updates and notification banners are not sent together."
          }
        >
          {deliveryOptions.map((option, index) => (
            <ListChoiceRow
              key={option.mode}
              label={option.label}
              description={option.description}
              selected={selectedMode === option.mode}
              separated={index > 0}
              disabled={choicesDisabled}
              onPress={() => void selectDeliveryMode(option.mode)}
            />
          ))}
        </SettingsSection>
        {liveActivityStatus === "signed-out" && canClearLiveActivitiesPreference ? (
          <SettingsSection>
            <SettingsRow
              icon="bolt.circle"
              label="Turn off Live Activity preference"
              onPress={() => void selectDeliveryMode("off")}
            />
          </SettingsSection>
        ) : null}
        {supportsAndroidLiveUpdateSettings() ? (
          <SettingsSection>
            <SettingsRow
              icon="bolt.circle"
              label="Live Update Settings"
              onPress={() => {
                void openAndroidLiveUpdateSettings().catch(() => {
                  Dialog.alert(
                    "Couldn't open Settings",
                    "Open Android Settings, select T3 Code, then enable Live Updates in Notifications.",
                  );
                });
              }}
            />
          </SettingsSection>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}
