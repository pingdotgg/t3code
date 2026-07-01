import { useAuth } from "@clerk/expo";
import { AuthView, UserProfileView } from "@clerk/expo/native";
import { NavigateTo, NativeStackScreenOptions } from "../../navigation/native-stack-header";
import { View } from "react-native";

import { hasCloudPublicConfig } from "../../features/cloud/publicConfig";
import { settingsNavigation } from "../../lib/routes";

export default function SettingsAuthRouteScreen() {
  return hasCloudPublicConfig() ? (
    <ConfiguredSettingsAuthRouteScreen />
  ) : (
    <NavigateTo href={settingsNavigation()} />
  );
}

function ConfiguredSettingsAuthRouteScreen() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });

  return (
    <>
      <NativeStackScreenOptions options={{ title: isSignedIn ? "Account" : "Sign in" }} />
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
