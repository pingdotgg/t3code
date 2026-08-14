import { useAuth } from "@clerk/expo";
import { AuthView, UserProfileView } from "@clerk/expo/native";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback, useLayoutEffect } from "react";
import { View } from "react-native";

import { hasCloudPublicConfig } from "../cloud/publicConfig";

export function SettingsAuthRouteScreen() {
  const navigation = useNavigation();

  useLayoutEffect(() => {
    if (!hasCloudPublicConfig()) {
      navigation.dispatch(StackActions.replace("SettingsContent"));
    }
  }, [navigation]);

  return hasCloudPublicConfig() ? <ConfiguredSettingsAuthRouteScreen /> : null;
}

function ConfiguredSettingsAuthRouteScreen() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const navigation = useNavigation();
  const handleHostBack = useCallback(
    () => navigation.dispatch(StackActions.popTo("SettingsContent")),
    [navigation],
  );

  return (
    <View collapsable={false} className="flex-1 overflow-hidden bg-sheet">
      {isLoaded ? (
        isSignedIn ? (
          <UserProfileView isDismissible={false} onHostBack={handleHostBack} />
        ) : (
          <AuthView isDismissible={false} onHostBack={handleHostBack} />
        )
      ) : null}
    </View>
  );
}
