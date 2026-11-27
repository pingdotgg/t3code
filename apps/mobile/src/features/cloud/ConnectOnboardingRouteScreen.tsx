import { useGT } from "gt-react-native";
import { AppBar } from "../../components/ui/AppBar";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";

import { useAuth } from "@clerk/expo";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { View } from "react-native";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { reportAtomCommandResult, settlePromise } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/ui/AppText";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { CloudEnvironmentRows } from "../connection/CloudEnvironmentRows";
import { splitEnvironmentSections } from "../connection/environmentSections";
import { useConnectionController } from "../connection/useConnectionController";
import {
  ConnectionTracesSwitch,
  connectionTracesAvailable,
} from "../observability/ConnectionTracesSwitch";
import { optOutOfConnectOnboarding } from "./connectOnboardingOptOut";
import { hasCloudPublicConfig } from "./publicConfig";

// Only reachable with cloud config: onboarding is requested after a T3 Connect
// sign-in, and appLinking drops the deep link otherwise.
export function ConnectOnboardingRouteScreen() {
  return hasCloudPublicConfig() ? <ConfiguredConnectOnboardingRouteScreen /> : null;
}

function ConfiguredConnectOnboardingRouteScreen() {
  const gt = useGT();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const { connectedEnvironments, onSetEnvironmentEnabled, onRemoveEnvironmentPress } =
    useRemoteConnections();
  const { refreshRelayEnvironments } = useConnectionController();
  const { connectedCloudEnvironments } = splitEnvironmentSections({
    connectedEnvironments,
    cloudEnvironments: null,
  });

  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = () => {
    setIsRefreshing(true);
    void refreshRelayEnvironments().finally(() => setIsRefreshing(false));
  };

  const handleClose = () => {
    navigation.goBack();
  };

  // Persist before dismissing so quick sign-out/sign-in cannot outrun the write.
  const handleDontShowAgain = () => {
    void (async () => {
      if (userId) {
        const result = await settlePromise(() => optOutOfConnectOnboarding(userId));
        reportAtomCommandResult(result, { label: "connect onboarding opt-out" });
      }
      navigation.goBack();
    })();
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar
        title={gt("Set up {product}", { product: "T3 Connect" })}
        onClose={handleClose}
        refresh={{
          accessibilityLabel: gt("Refresh environments"),
          disabled: isRefreshing,
          onPress: handleRefresh,
        }}
      />
      <ScrollView
        nestedScrollEnabled
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerStyle={{
          gap: 16,
          paddingHorizontal: 20,
          paddingTop: 16,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />}
      >
        {isSignedIn ? (
          <CloudEnvironmentRows
            connectedCloudEnvironments={connectedCloudEnvironments}
            onSetEnvironmentEnabled={onSetEnvironmentEnabled}
            onRemoveEnvironment={onRemoveEnvironmentPress}
            showHeader={false}
          />
        ) : (
          <View collapsable={false} className="rounded-[24px] bg-grouped-card p-5">
            <Text className="text-sm leading-normal text-foreground-muted">
              {gt("Sign in to your T3 account to set up {product}.", { product: "T3 Connect" })}
            </Text>
          </View>
        )}

        {isSignedIn && connectionTracesAvailable ? (
          <View collapsable={false} className="gap-2">
            <View collapsable={false} className="overflow-hidden rounded-[24px] bg-grouped-card">
              <ConnectionTracesSwitch />
            </View>
            <Text className="px-2 text-sm leading-normal text-foreground-muted">
              {gt(
                "Helps the T3 Code team fix connection problems. Traces hold timings, error types, an ID for this app session, and the app version, never your threads, prompts, or code. You can change this in Settings > About T3 Code > Diagnostics.",
              )}
            </Text>
          </View>
        ) : null}

        {userId ? (
          <Button label={gt("Don't show this again")} tone="text" onPress={handleDontShowAgain} />
        ) : null}
      </ScrollView>
    </View>
  );
}
