import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SettingsScreen } from "./components/SettingsScreen";
import { LocalEnvironmentList } from "../connection/LocalEnvironmentList";
import { PullRequestRoutingSettings } from "../connection/PullRequestRoutingSettings";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import {
  applyShowcaseLocalEnvironmentDisplayUrls,
  resolveShowcaseEnvironmentUpdateDisplayUrl,
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
  const localEnvironments = SHOWCASE_ENABLED
    ? applyShowcaseLocalEnvironmentDisplayUrls(connectedEnvironments)
    : connectedEnvironments;
  const headerIconColor = useUniwindTheme()["--color-icon"];

  const openEnvironment = (environmentId: EnvironmentId) => {
    navigation.navigate("SettingsEnvironmentDetail", { environmentId });
  };
  const handleUpdateEnvironment = (
    environmentId: EnvironmentId,
    updates: { readonly label: string; readonly displayUrl: string },
  ) => {
    if (!SHOWCASE_ENABLED) return onUpdateEnvironment(environmentId, updates);
    const actualEnvironment = connectedEnvironments.find(
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

  return (
    <SettingsScreen
      title="Environments"
      actions={[
        {
          accessibilityLabel: "Add environment",
          icon: "plus",
          tintColor: headerIconColor,
          onPress: () => navigation.navigate("SettingsEnvironmentNew"),
        },
      ]}
    >
      <ScrollView
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
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

        <PullRequestRoutingSettings />
      </ScrollView>
    </SettingsScreen>
  );
}
