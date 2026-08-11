import {
  NativeHeaderToolbar,
  NativeStackScreenOptions,
} from "../../native/StackHeader";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { CloudEnvironmentRows } from "../connection/CloudEnvironmentRows";
import { ConnectionEnvironmentList } from "../connection/ConnectionEnvironmentList";
import { splitEnvironmentSections } from "../connection/environmentSections";
import { useThemeColor } from "../../lib/useThemeColor";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import {
  applyShowcaseLocalEnvironmentDisplayUrls,
  resolveShowcaseEnvironmentUpdateDisplayUrl,
  SHOWCASE_AVAILABLE_CLOUD_ENVIRONMENTS,
  SHOWCASE_CONNECTED_CLOUD_ENVIRONMENTS,
} from "../showcase/showcaseEnvironmentRows";
import { markNativeShowcaseReady } from "../showcase/nativeShowcaseScene";

const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";

export function SettingsEnvironmentsRouteScreen() {
  const {
    connectedEnvironments,
    onReconnectEnvironment,
    onSetEnvironmentEnabled,
    onRemoveEnvironmentPress,
    onUpdateEnvironment,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentSections = splitEnvironmentSections({
    connectedEnvironments,
    cloudEnvironments: null,
  });
  const localEnvironments = SHOWCASE_ENABLED
    ? applyShowcaseLocalEnvironmentDisplayUrls(
        environmentSections.localEnvironments,
      )
    : environmentSections.localEnvironments;
  const connectedCloudEnvironments = SHOWCASE_ENABLED
    ? SHOWCASE_CONNECTED_CLOUD_ENVIRONMENTS
    : environmentSections.connectedCloudEnvironments;
  const [expandedId, setExpandedId] = useState<EnvironmentId | null>(null);
  const headerIconColor = useThemeColor("--color-icon");

  useEffect(() => {
    if (!SHOWCASE_ENABLED) return;
    const timer = setTimeout(
      () => markNativeShowcaseReady("environments"),
      500,
    );
    return () => clearTimeout(timer);
  }, []);

  const handleToggle = useCallback((environmentId: EnvironmentId) => {
    setExpandedId((prev) => (prev === environmentId ? null : environmentId));
  }, []);
  const handleUpdateEnvironment = useCallback(
    (
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
    },
    [
      environmentSections.localEnvironments,
      localEnvironments,
      onUpdateEnvironment,
    ],
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          {/* Android renders its own in-screen header instead of the native bar. */}
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title="Environments"
            onBack={() => navigation.goBack()}
            actions={[
              {
                accessibilityLabel: "Add environment",
                icon: "plus",
                onPress: () =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsEnvironmentNew",
                  }),
              },
            ]}
          />
        </>
      ) : (
        <NativeHeaderToolbar placement="right">
          <NativeHeaderToolbar.Button
            icon="plus"
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsEnvironmentNew",
              })
            }
            separateBackground
            tintColor={headerIconColor}
          />
        </NativeHeaderToolbar>
      )}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <ConnectionEnvironmentList
          environments={localEnvironments}
          expandedId={expandedId}
          onToggle={handleToggle}
          onReconnect={onReconnectEnvironment}
          onSetEnabled={onSetEnvironmentEnabled}
          onRemove={onRemoveEnvironmentPress}
          onUpdate={handleUpdateEnvironment}
        />

        {/* Always mounted: already-connected relay environments must stay
            visible (and removable) even when cloud config is missing or the
            user is signed out — the component gates discovery itself. */}
        <CloudEnvironmentRows
          connectedCloudEnvironments={connectedCloudEnvironments}
          onReconnectEnvironment={onReconnectEnvironment}
          onSetEnvironmentEnabled={onSetEnvironmentEnabled}
          {...(SHOWCASE_ENABLED
            ? {
                showcaseAvailableEnvironments:
                  SHOWCASE_AVAILABLE_CLOUD_ENVIRONMENTS,
                showcaseSignedIn: true,
              }
            : {})}
        />
      </ScrollView>
    </View>
  );
}
