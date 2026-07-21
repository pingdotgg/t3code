import { useAuth } from "@clerk/expo";
import { AuthView, UserProfileView } from "@clerk/expo/native";
import { Redirect, Stack } from "expo-router";
import { View } from "react-native";

import { hasCloudPublicConfig } from "../../features/cloud/publicConfig";

export default function SettingsAuthRouteScreen() {
  return hasCloudPublicConfig() ? (
    <ConfiguredSettingsAuthRouteScreen />
  ) : (
    <Redirect href="/settings" />
  );
}

function ConfiguredSettingsAuthRouteScreen() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });

  return (
    <>
      <Stack.Screen options={{ title: isSignedIn ? "Account" : "Sign in" }} />
      <View collapsable={false} className="flex-1 overflow-hidden bg-sheet">
        {isLoaded ? (
          isSignedIn ? (
            <UserProfileView isDismissible={false} />
          ) : (
            <AuthView isDismissible={false} />
          )
        ) : null}
      </View>
    </>
  );
}
