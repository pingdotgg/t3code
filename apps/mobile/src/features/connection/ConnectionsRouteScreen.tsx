import { Toolbar } from "../../components/ui/Toolbar";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";

import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useState } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { LocalEnvironmentList } from "./LocalEnvironmentList";
import { GitHubRoutingSettings } from "./GitHubRoutingSettings";
import { LinkedEnvironmentsSection } from "./LinkedEnvironmentsSection";

export function ConnectionsRouteScreen() {
  const {
    connectedEnvironments,
    onReconnectEnvironment,
    onRemoveEnvironmentPress,
    onSetEnvironmentEnabled,
    onUpdateEnvironment,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [expandedId, setExpandedId] = useState<EnvironmentId | null>(null);
  const handleToggle = useCallback((environmentId: EnvironmentId) => {
    setExpandedId((prev) => (prev === environmentId ? null : environmentId));
  }, []);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title="Environments"
          onBack={() => navigation.goBack()}
          actions={[
            {
              accessibilityLabel: "Add environment",
              icon: "plus",
              onPress: () => navigation.navigate("ConnectionsNew"),
            },
          ]}
        />
      ) : (
        <Toolbar placement="right">
          <Toolbar.Button
            icon="plus"
            onPress={() => navigation.navigate("ConnectionsNew")}
            separateBackground
          />
        </Toolbar>
      )}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
      >
        <LocalEnvironmentList
          environments={connectedEnvironments}
          expandedId={expandedId}
          onToggle={handleToggle}
          onReconnect={onReconnectEnvironment}
          onRemove={onRemoveEnvironmentPress}
          onSetEnabled={onSetEnvironmentEnabled}
          onUpdate={onUpdateEnvironment}
        />
        {connectedEnvironments
          .filter((environment) => environment.connectionState === "connected")
          .map((environment) => (
            <LinkedEnvironmentsSection
              key={environment.environmentId}
              environmentId={environment.environmentId}
              environmentLabel={environment.environmentLabel}
            />
          ))}
        <GitHubRoutingSettings />
      </ScrollView>
    </View>
  );
}
