import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { msg, useGT, useMessages } from "gt-react-native";
import * as Dialog from "../../components/ui/Dialog";
import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import {
  AuthRelayConfigureScope,
  AuthRelayWriteScope,
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
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState, useSyncExternalStore } from "react";
import { Linking, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { m as resolveMessage } from "../../i18n/messages";

import { AppText as Text } from "../../components/ui/AppText";
import {
  createEnvironmentCommand,
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
import {
  LiveActivityEnvironmentUpdateError,
  setLiveActivityUpdatesEnabled,
} from "../agent-awareness/liveActivityPreferences";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import {
  agentAwarenessNotificationsReady,
  getAgentAwarenessRegistrationStatus,
  refreshAgentAwarenessRegistration,
  subscribeAgentAwarenessRegistrationStatus,
} from "../agent-awareness/remoteRegistration";
import { connectionAtomRuntime } from "../../connection/runtime";
import {
  CloudEnvironmentLinkError,
  linkEnvironmentToCloudWithPreference,
  updateLinkedEnvironmentLiveActivityPreference,
} from "../cloud/linkEnvironment";
import { refreshManagedRelayEnvironments } from "../cloud/managedRelayState";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "../cloud/publicConfig";
import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import { runtime } from "../../lib/runtime";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { resolveAgentAwarenessPlatformPresentation } from "./SettingsRouteScreen.logic";

const updateLiveActivityPreference = createEnvironmentCommand(connectionAtomRuntime, {
  label: "updateLiveActivityPreference",
  execute: updateLinkedEnvironmentLiveActivityPreference,
});

const linkLiveActivityEnvironment = createEnvironmentCommand(connectionAtomRuntime, {
  label: "linkLiveActivityEnvironment",
  execute: linkEnvironmentToCloudWithPreference,
});

const isLiveActivityEnvironmentUpdateError = Schema.is(LiveActivityEnvironmentUpdateError);
const isCloudEnvironmentLinkError = Schema.is(CloudEnvironmentLinkError);

function toCloudEnvironmentLinkError(cause: unknown, message: string) {
  return isCloudEnvironmentLinkError(cause)
    ? cause
    : new CloudEnvironmentLinkError({ message, cause });
}

const updateEnvironmentPreference = Effect.fn("updateEnvironmentPreference")(function* (
  environmentId: EnvironmentId,
  enabled: boolean,
) {
  const result = yield* Effect.promise(() =>
    updateLiveActivityPreference.run(appAtomRegistry, { environmentId, input: enabled }),
  );
  if (result._tag === "Success") return result.value;
  return yield* toCloudEnvironmentLinkError(
    squashAtomCommandFailure(result),
    resolveMessage(msg("Could not update the environment's Live Activity preference.")),
  );
});

const linkEnvironmentWithPreference = Effect.fn("linkEnvironmentWithPreference")(function* (
  environmentId: EnvironmentId,
  input: { readonly clerkToken: string; readonly liveActivitiesEnabled: boolean },
) {
  const result = yield* Effect.promise(() =>
    linkLiveActivityEnvironment.run(appAtomRegistry, { environmentId, input }),
  );
  if (result._tag === "Success") return;
  return yield* toCloudEnvironmentLinkError(
    squashAtomCommandFailure(result),
    resolveMessage(msg("Could not configure environment relay access.")),
  );
});

/**
 * A policy that turns Connect off refuses relay links and preferences, which would fail the
 * whole batch, so those environments are skipped like ones this session cannot configure.
 */
function canManageConnect(
  environmentId: EnvironmentId,
  scope: typeof AuthRelayConfigureScope | typeof AuthRelayWriteScope,
) {
  const policy = appAtomRegistry.get(
    serverEnvironment.configValueAtom(environmentId),
  )?.managedPolicy;
  return (
    readEnvironmentScope(environmentId, scope) &&
    managedCapabilityDenial(policy, "connect") === undefined
  );
}

type NotificationStatus = "checking" | "enabled" | "disabled" | "unsupported";
type LiveActivityStatus = "checking" | "enabled" | "disabled" | "signed-out" | "linking";

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

function useNotificationsReady(): boolean {
  return useSyncExternalStore(
    subscribeAgentAwarenessRegistrationStatus,
    agentAwarenessNotificationsReady,
    () => false,
  );
}

export function SettingsNotificationsRouteScreen() {
  const gt = useGT();
  if (!hasCloudPublicConfig()) {
    return (
      <SettingsScreen title={gt("Notifications")}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-5 pt-4"
        >
          <Text className="text-base text-foreground-muted">
            {gt("Notifications require {product} in this app build.", { product: "T3 Connect" })}
          </Text>
        </ScrollView>
      </SettingsScreen>
    );
  }

  return <ConfiguredSettingsNotificationsRouteScreen />;
}

function ConfiguredSettingsNotificationsRouteScreen() {
  const gt = useGT();
  const m = useMessages();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const agentAwarenessPushAvailable = supportsAgentAwarenessPush();
  const agentAwarenessPlatform = resolveAgentAwarenessPlatformPresentation(Platform.OS, m);
  const agentAwarenessSubtitle =
    Platform.OS === "android" && !agentAwarenessPushAvailable
      ? gt("Install a newer app build to enable notifications")
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
  const notificationsReady = useNotificationsReady();
  const liveActivitiesPreferenceEnabled = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.liveActivitiesEnabled !== false
    : true;
  const canClearLiveActivitiesPreference =
    AsyncResult.isSuccess(preferencesResult) &&
    preferencesResult.value.liveActivitiesEnabled !== false;

  const connections = Object.values(savedConnectionsById);
  const environmentCount = connections.length;

  const requestNotifications = async () => {
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
          gt("Notifications unavailable"),
          error instanceof Error
            ? (errorDisplayMessage(error, resolveMessage) ?? error.message)
            : gt("Could not request notification permission."),
        );
      }
      return;
    }
    if (result.value.type === "granted") {
      setNotificationStatus("enabled");
      if (!agentAwarenessNotificationsReady()) {
        Dialog.alert(
          gt("Couldn't finish enabling notifications"),
          gt(
            "Notification access was granted, but this device could not be registered with {product}. Notifications will start once registration succeeds.",
            { product: "T3 Connect" },
          ),
        );
      }
      return;
    }
    if (result.value.type === "unsupported") {
      setNotificationStatus("unsupported");
      Dialog.alert(
        gt("Notifications unavailable"),
        gt("Agent notifications are unavailable on this platform."),
      );
      return;
    }
    setNotificationStatus("disabled");
    if (result.value.canAskAgain) {
      Dialog.alert(gt("Notifications disabled"), gt("Notifications were not enabled."));
      return;
    }
    Dialog.alert(
      gt("Notifications disabled"),
      gt("Notifications were denied for this app. Open Settings to enable them."),
      [
        { text: gt("Cancel"), style: "cancel" },
        { text: gt("Open Settings"), onPress: () => void Linking.openSettings() },
      ],
    );
  };

  const promptSignIn = () => {
    Dialog.alert(
      gt("Sign in to {product}", { product: "T3 Connect" }),
      gt("Live Activity updates require {product} so relay can deliver updates to this device.", {
        product: "T3 Connect",
      }),
      [
        { text: gt("Cancel"), style: "cancel" },
        {
          text: gt("Continue"),
          onPress: () => navigation.navigate("SettingsAuth"),
        },
      ],
    );
  };

  const linkEnvironments = async () => {
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
        Dialog.alert(
          gt("Ongoing activity unavailable"),
          error instanceof Error
            ? (errorDisplayMessage(error, resolveMessage) ?? error.message)
            : gt("Could not enable agent notifications."),
        );
        return;
      }
      if (permission.value.type !== "granted") {
        setLiveActivityStatus("disabled");
        Dialog.alert(
          gt("Notification permission needed"),
          gt("Enable notifications in system Settings to show ongoing agent activity."),
          [
            { text: gt("Cancel"), style: "cancel" },
            { text: gt("Open Settings"), onPress: () => void Linking.openSettings() },
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
      Dialog.alert(
        Platform.OS === "android"
          ? gt("Ongoing activity unavailable")
          : gt("Live Activities unavailable"),
        error instanceof Error
          ? (errorDisplayMessage(error, resolveMessage) ?? error.message)
          : gt("Could not enable agent activity updates."),
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
          updateEnvironment: updateEnvironmentPreference,
          linkEnvironment: linkEnvironmentWithPreference,
          canConfigureEnvironment: (id) => canManageConnect(id, AuthRelayConfigureScope),
          canUpdateEnvironment: (id) => canManageConnect(id, AuthRelayWriteScope),
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
        if (reportPartialEnvironmentUpdate(error)) return;
        Dialog.alert(
          Platform.OS === "android"
            ? gt("Ongoing activity unavailable")
            : gt("Live Activities unavailable"),
          error instanceof Error
            ? (errorDisplayMessage(error, resolveMessage) ?? error.message)
            : gt("Could not enable agent activity updates."),
        );
      }
      return;
    }

    savePreferences({ liveActivitiesEnabled: true });
    refreshManagedRelayEnvironments();
    setLiveActivityStatus("enabled");
    // Environment linking can precede device registration; only registered devices can receive Live Activities.
    if (updateResult.value) {
      Dialog.alert(
        gt("Some environments need an update"),
        gt(
          "The device preference was saved. Update older environment servers to apply the setting there.",
        ),
      );
    } else if (getAgentAwarenessRegistrationStatus() === "registered") {
      Dialog.alert(
        Platform.OS === "android" ? gt("Ongoing activity enabled") : gt("Live Activities enabled"),
        environmentCount > 0
          ? gt("Agent activity updates are enabled for eligible environments.")
          : gt(
              "Agent activity updates are enabled. Add an environment to start receiving updates.",
            ),
      );
    } else {
      Dialog.alert(
        gt("Couldn't finish enabling activity updates"),
        gt(
          "This device could not be registered with {product}, so activity updates won't appear yet. They'll start once registration succeeds.",
          { product: "T3 Connect" },
        ),
      );
    }
  };

  const handleDeviceNotificationsChange = (enabled: boolean) => {
    if (enabled) {
      if (!isSignedIn) {
        promptSignIn();
        return;
      }
      void requestNotifications();
      return;
    }

    Dialog.alert(
      gt("Disable notifications"),
      gt("Open system Settings to disable notifications for {product}.", { product: "T3 Code" }),
      [
        { text: gt("Cancel"), style: "cancel" },
        { text: gt("Open Settings"), onPress: () => void Linking.openSettings() },
      ],
    );
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
        return;
      }
      token = tokenResult.value;
    }

    const updateResult = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        setLiveActivityUpdatesEnabled({
          updateEnvironment: updateEnvironmentPreference,
          linkEnvironment: linkEnvironmentWithPreference,
          canConfigureEnvironment: (id) => canManageConnect(id, AuthRelayConfigureScope),
          canUpdateEnvironment: (id) => canManageConnect(id, AuthRelayWriteScope),
          enabled: false,
          previousEnabled: liveActivitiesPreferenceEnabled,
          clerkToken: token,
          connections,
        }),
      ),
    );
    if (updateResult._tag === "Failure") {
      setLiveActivityStatus(isSignedIn ? "enabled" : "signed-out");
      if (!reportPartialEnvironmentUpdate(squashAtomCommandFailure(updateResult))) {
        reportAtomCommandResult(updateResult, {
          label: "live activity disable",
        });
      }
      return;
    }
    savePreferences({ liveActivitiesEnabled: false });
    refreshManagedRelayEnvironments();
    setLiveActivityStatus("disabled");
    if (updateResult.value) {
      Dialog.alert(
        gt("Some environments need an update"),
        gt(
          "The device preference was saved. Update older environment servers to apply the setting there.",
        ),
      );
    }
  }

  function reportPartialEnvironmentUpdate(error: unknown): boolean {
    if (!isLiveActivityEnvironmentUpdateError(error)) return false;
    refreshManagedRelayEnvironments();
    Dialog.alert(
      gt("Some environments were updated"),
      gt("The device setting was not saved. The new setting was applied to: {environments}.", {
        environments: error.updatedEnvironments.join(", "),
      }),
    );
    return true;
  }

  // Both writers settle their own failures, so awaiting them never throws.
  const handleLiveActivitiesChange = async (enabled: boolean) => {
    if (liveActivityWriteInFlight.current) return;
    if (!enabled) {
      liveActivityWriteInFlight.current = true;
      setLiveActivityStatus("linking");
      await disableLiveActivities();
      liveActivityWriteInFlight.current = false;
      return;
    }

    if (!isSignedIn) {
      promptSignIn();
      return;
    }

    liveActivityWriteInFlight.current = true;
    await linkEnvironments();
    liveActivityWriteInFlight.current = false;
  };

  return (
    <SettingsScreen title={gt("Notifications")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title={gt("Agent activity")}>
          <SettingsSwitchRow
            icon="bell.badge"
            label={gt("Device Notifications")}
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              notificationStatus === "checking" ||
              notificationStatus === "unsupported"
            }
            subtitle={agentAwarenessSubtitle}
            value={
              agentAwarenessPushAvailable && notificationStatus === "enabled" && notificationsReady
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
                  ? gt("Agent Live Updates")
                  : gt("Ongoing Agent Activity")
                : gt("Live Activity Updates")
            }
            subtitle={agentAwarenessSubtitle}
            value={
              agentAwarenessPushAvailable &&
              (liveActivityStatus === "enabled" || liveActivityStatus === "linking") &&
              deviceRegistered
            }
            onValueChange={(enabled) => void handleLiveActivitiesChange(enabled)}
          />
          {liveActivityStatus === "signed-out" && canClearLiveActivitiesPreference ? (
            <SettingsRow
              icon="bolt.circle"
              label={gt("Turn off Live Activity preference")}
              onPress={() => void handleLiveActivitiesChange(false)}
            />
          ) : null}
          {supportsAndroidLiveUpdateSettings() ? (
            <SettingsRow
              icon="bolt.circle"
              label={gt("Live Update Settings")}
              onPress={() => {
                void openAndroidLiveUpdateSettings().catch(() => {
                  Dialog.alert(
                    gt("Couldn't open Settings"),
                    gt(
                      "Open Android Settings, select {product}, then enable Live Updates in Notifications.",
                      { product: "T3 Code" },
                    ),
                  );
                });
              }}
            />
          ) : null}
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
