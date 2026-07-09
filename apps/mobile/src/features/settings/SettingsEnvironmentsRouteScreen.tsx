import { NativeHeaderToolbar } from "../../native/StackHeader";
import { useNavigation } from "@react-navigation/native";
import { SymbolView } from "expo-symbols";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { CloudEnvironmentRows } from "../connection/CloudEnvironmentRows";
import { ConnectionEnvironmentRow } from "../connection/ConnectionEnvironmentRow";
import { splitEnvironmentSections } from "../connection/environmentSections";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";

export function SettingsEnvironmentsRouteScreen() {
  const {
    connectedEnvironments,
    onReconnectEnvironment,
    onRemoveEnvironmentPress,
    onUpdateEnvironment,
  } = useRemoteConnections();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { localEnvironments, connectedCloudEnvironments } = splitEnvironmentSections({
    connectedEnvironments,
    cloudEnvironments: null,
  });
  const hasLocalEnvironments = localEnvironments.length > 0;
  const [expandedId, setExpandedId] = useState<EnvironmentId | null>(null);
  const accentColor = useThemeColor("--color-icon-muted");
  const headerIconColor = useThemeColor("--color-icon");

  const handleToggle = useCallback((environmentId: EnvironmentId) => {
    setExpandedId((prev) => (prev === environmentId ? null : environmentId));
  }, []);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeHeaderToolbar placement="right">
        <NativeHeaderToolbar.Button
          icon="plus"
          onPress={() => navigation.navigate("SettingsSheet", { screen: "SettingsEnvironmentNew" })}
          separateBackground
          tintColor={headerIconColor}
        />
      </NativeHeaderToolbar>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        {hasLocalEnvironments ? (
          <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
            {localEnvironments.map((environment, index) => (
              <View
                key={environment.environmentId}
                collapsable={false}
                className={cn(index !== 0 && "border-t border-border")}
              >
                <ConnectionEnvironmentRow
                  environment={environment}
                  expanded={expandedId === environment.environmentId}
                  onToggle={() => handleToggle(environment.environmentId)}
                  onReconnect={onReconnectEnvironment}
                  onRemove={onRemoveEnvironmentPress}
                  onUpdate={onUpdateEnvironment}
                />
              </View>
            ))}
          </View>
        ) : (
          <View collapsable={false} className="items-center gap-3 rounded-[24px] bg-card px-6 py-8">
            <View className="h-12 w-12 items-center justify-center rounded-[16px] bg-subtle">
              <SymbolView
                name="point.3.connected.trianglepath.dotted"
                size={20}
                tintColor={accentColor}
                type="monochrome"
              />
            </View>
            <Text className="text-center text-sm leading-normal text-foreground-muted">
              No environments connected yet.{"\n"}Tap{" "}
              <Text className="font-t3-bold text-foreground">+</Text> to add one.
            </Text>
          </View>
        )}

        {hasCloudPublicConfig() ? (
          <CloudEnvironmentRows
            connectedCloudEnvironments={connectedCloudEnvironments}
            onReconnectEnvironment={onReconnectEnvironment}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}
