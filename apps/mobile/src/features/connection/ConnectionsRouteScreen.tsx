import { NativeHeaderToolbar } from "../../native/StackHeader";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { ConnectionEnvironmentList } from "./ConnectionEnvironmentList";

export function ConnectionsRouteScreen() {
  const {
    connectedEnvironments,
    onReconnectEnvironment,
    onSetEnvironmentEnabled,
    onRemoveEnvironmentPress,
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
        <NativeHeaderToolbar placement="right">
          <NativeHeaderToolbar.Button
            icon="plus"
            onPress={() => navigation.navigate("ConnectionsNew")}
            separateBackground
          />
        </NativeHeaderToolbar>
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
        <ConnectionEnvironmentList
          environments={connectedEnvironments}
          expandedId={expandedId}
          onToggle={handleToggle}
          onReconnect={onReconnectEnvironment}
          onSetEnabled={onSetEnvironmentEnabled}
          onRemove={onRemoveEnvironmentPress}
          onUpdate={onUpdateEnvironment}
        />
      </ScrollView>
    </View>
  );
}
