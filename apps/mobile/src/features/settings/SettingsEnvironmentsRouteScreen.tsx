import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import { startTransition, useCallback, useRef, useState } from "react";
import { RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SettingsScreen } from "./components/SettingsScreen";
import { CloudEnvironmentRows } from "../connection/CloudEnvironmentRows";
import { LocalEnvironmentList } from "../connection/LocalEnvironmentList";
import { PullRequestRoutingSettings } from "../connection/PullRequestRoutingSettings";
import { splitEnvironmentSections } from "../connection/environmentSections";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { relayEnvironmentDiscovery } from "../../state/relay";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  applyShowcaseLocalEnvironmentDisplayUrls,
  resolveShowcaseEnvironmentUpdateDisplayUrl,
  SHOWCASE_AVAILABLE_CLOUD_ENVIRONMENTS,
  SHOWCASE_CONNECTED_CLOUD_ENVIRONMENTS,
} from "../showcase/showcaseEnvironmentRows";

const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";

export function SettingsEnvironmentsRouteScreen() {
  const {
    connectedEnvironments,
    onReconnectEnvironment,
    onRemoveEnvironmentPress,
    onSetEnvironmentEnabled,
    onUpdateEnvironment,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentSections = splitEnvironmentSections({
    connectedEnvironments,
    cloudEnvironments: null,
  });
  const localEnvironments = SHOWCASE_ENABLED
    ? applyShowcaseLocalEnvironmentDisplayUrls(environmentSections.localEnvironments)
    : environmentSections.localEnvironments;
  const connectedCloudEnvironments = SHOWCASE_ENABLED
    ? SHOWCASE_CONNECTED_CLOUD_ENVIRONMENTS
    : environmentSections.connectedCloudEnvironments;
  const headerIconColor = useUniwindTheme()["--color-icon"];
  const relaySession = useAtomValue(managedRelaySessionAtom);
  const refreshRelayEnvironments = useAtomCommand(
    relayEnvironmentDiscovery.refresh,
    "relay environment refresh",
  );
  const [isRefreshingCloud, setIsRefreshingCloud] = useState(false);
  const cloudRefreshPendingRef = useRef(false);
  async function refreshCloudEnvironments() {
    if (!relaySession || cloudRefreshPendingRef.current) return;
    cloudRefreshPendingRef.current = true;
    setIsRefreshingCloud(true);
    await refreshRelayEnvironments();
    cloudRefreshPendingRef.current = false;
    setIsRefreshingCloud(false);
  }

  const openEnvironment = (environmentId: EnvironmentId) => {
    navigation.navigate("SettingsEnvironmentDetail", { environmentId });
  };
  const handleUpdateEnvironment = (
    environmentId: EnvironmentId,
    updates: { readonly label: string; readonly displayUrl: string },
  ) => {
    if (!SHOWCASE_ENABLED) return onUpdateEnvironment(environmentId, updates);
    const actualEnvironment = environmentSections.localEnvironments.find(
      (environment) => environment.environmentId === environmentId,
    );
    const presentedEnvironment = localEnvironments.find(
      (environment) => environment.environmentId === environmentId,
    );
    return onUpdateEnvironment(environmentId, {
      ...updates,
      displayUrl:
        actualEnvironment && presentedEnvironment
          ? resolveShowcaseEnvironmentUpdateDisplayUrl({
              actualDisplayUrl: actualEnvironment.displayUrl,
              presentedDisplayUrl: presentedEnvironment.displayUrl,
              submittedDisplayUrl: updates.displayUrl,
            })
          : updates.displayUrl,
    });
  };
  // Sheet chrome first; the env list waits until the push can settle.
  const [listReady, setListReady] = useState(false);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const timer = setTimeout(() => {
        if (cancelled) return;
        startTransition(() => {
          setListReady(true);
        });
      }, 800);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }, []),
  );

  return (
    <SettingsScreen
      title="Environments"
      eagerBody
      refresh={
        relaySession
          ? {
              accessibilityLabel: "Refresh cloud environments",
              disabled: isRefreshingCloud,
              onPress: () => void refreshCloudEnvironments(),
            }
          : undefined
      }
      actions={[
        {
          accessibilityLabel: "Add environment",
          icon: "plus",
          tintColor: headerIconColor,
          onPress: () => navigation.navigate("SettingsEnvironmentNew"),
        },
      ]}
    >
      {listReady ? (
        <ScrollView
          alwaysBounceVertical
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="px-5 pt-4"
          contentContainerStyle={{
            paddingBottom: Math.max(insets.bottom, 18) + 18,
          }}
          refreshControl={
            relaySession ? (
              <RefreshControl
                refreshing={isRefreshingCloud}
                onRefresh={() => void refreshCloudEnvironments()}
              />
            ) : undefined
          }
        >
          <LocalEnvironmentList
            environments={localEnvironments}
            expandedId={null}
            onToggle={openEnvironment}
            opensDetails
            onReconnect={onReconnectEnvironment}
            onRemove={onRemoveEnvironmentPress}
            onSetEnabled={onSetEnvironmentEnabled}
            onUpdate={handleUpdateEnvironment}
          />

          {/* Keep connected relays visible and removable without cloud config or sign-in; this component gates discovery. */}
          <CloudEnvironmentRows
            connectedCloudEnvironments={connectedCloudEnvironments}
            onOpenEnvironment={openEnvironment}
            onSetEnvironmentEnabled={onSetEnvironmentEnabled}
            onRemoveEnvironment={onRemoveEnvironmentPress}
            {...(SHOWCASE_ENABLED
              ? {
                  showcaseAvailableEnvironments: SHOWCASE_AVAILABLE_CLOUD_ENVIRONMENTS,
                  showcaseSignedIn: true,
                }
              : {})}
          />
          <PullRequestRoutingSettings />
        </ScrollView>
      ) : (
        <View className="gap-4 px-5 pt-4">
          <View className="bg-border/40 h-12 rounded-2xl" />
          <View className="bg-border/30 h-12 rounded-2xl" />
          <View className="bg-border/20 h-12 rounded-2xl" />
        </View>
      )}
    </SettingsScreen>
  );
}
