import { Stack, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { ConnectionEnvironmentRow } from "../../features/connection/ConnectionEnvironmentRow";

export default function ConnectionsRouteScreen() {
  const {
    connectedEnvironments,
    onReconnectEnvironment,
    onRemoveEnvironmentPress,
    onUpdateEnvironment,
  } = useRemoteConnections();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const hasEnvironments = connectedEnvironments.length > 0;
  const [expandedId, setExpandedId] = useState<EnvironmentId | null>(null);

  const accentColor = useThemeColor("--color-icon-muted");

  const handleToggle = useCallback((environmentId: EnvironmentId) => {
    setExpandedId((prev) => (prev === environmentId ? null : environmentId));
  }, []);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <Stack.Screen
        options={{
          title: "Environments",
        }}
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="plus"
          onPress={() => router.push("/connections/new")}
          separateBackground
        />
      </Stack.Toolbar>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
      >
        {hasEnvironments ? (
          <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
            {connectedEnvironments.map((environment, index) => (
              <View
                key={environment.environmentId}
                collapsable={false}
                style={{
                  borderTopWidth: index === 0 ? 0 : 1,
                }}
                className={cn(index !== 0 && "border-border")}
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
            <Text className="text-center text-sm leading-[20px] text-foreground-muted">
              No environments connected yet.{"\n"}Tap{" "}
              <Text className="font-t3-bold text-foreground">+</Text> to add one.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
