import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { IconButton } from "../../components/ui/IconButton";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";

import { useAuth } from "@clerk/expo";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { Platform, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { reportAtomCommandResult, settlePromise } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/ui/AppText";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { CloudEnvironmentRows } from "../connection/CloudEnvironmentRows";
import { splitEnvironmentSections } from "../connection/environmentSections";
import { useConnectionController } from "../connection/useConnectionController";
import { optOutOfConnectOnboarding } from "./connectOnboardingOptOut";
import { hasCloudPublicConfig } from "./publicConfig";

export function ConnectOnboardingRouteScreen() {
  const navigation = useNavigation();

  // Without cloud config, deep links must exit to avoid an empty, undismissable sheet.
  useEffect(() => {
    if (hasCloudPublicConfig()) {
      return;
    }
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.dispatch(StackActions.replace("Home"));
    }
  }, [navigation]);

  return hasCloudPublicConfig() ? <ConfiguredConnectOnboardingRouteScreen /> : null;
}

function ConfiguredConnectOnboardingRouteScreen() {
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
      <SheetHeader
        presentation={Platform.OS === "android" ? "inline" : "native"}
        title="Set up T3 Connect"
        onClose={handleClose}
        trailing={
          Platform.OS === "android" ? (
            isRefreshing ? (
              <View
                className="size-12 items-center justify-center"
                accessible
                accessibilityLabel="Refreshing environments"
                accessibilityState={{ busy: true }}
              >
                <AppActivityIndicator />
              </View>
            ) : (
              <IconButton
                accessibilityLabel="Refresh environments"
                icon="arrow.clockwise"
                onPress={handleRefresh}
              />
            )
          ) : undefined
        }
      />
      <ScrollView
        nestedScrollEnabled
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={{
          gap: 16,
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
        refreshControl={
          Platform.OS === "ios" ? (
            <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />
          ) : undefined
        }
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
              Sign in to your T3 account to set up T3 Connect.
            </Text>
          </View>
        )}

        {userId ? (
          <Button label={"Don't show this again"} tone="text" onPress={handleDontShowAgain} />
        ) : null}
      </ScrollView>
    </View>
  );
}
