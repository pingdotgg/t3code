import { useAuth } from "@clerk/expo";
import { AuthView, UserProfileView } from "@clerk/expo/native";
import { StackActions, useNavigation } from "@react-navigation/native";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEffect, useRef } from "react";
import { View } from "react-native";

import { hasCloudPublicConfig } from "../cloud/publicConfig";

export function SettingsAuthRouteScreen() {
  const navigation = useNavigation();

  useEffect(() => {
    if (!hasCloudPublicConfig()) {
      navigation.dispatch(StackActions.replace("Settings"));
    }
  }, [navigation]);

  return hasCloudPublicConfig() ? <ConfiguredSettingsAuthRouteScreen /> : null;
}

function ConfiguredSettingsAuthRouteScreen() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const navigation = useNavigation();

  const hasBeenSignedIn = useRef(isSignedIn);
  if (isSignedIn) {
    hasBeenSignedIn.current = true;
  }

  useEffect(() => {
    if (hasBeenSignedIn.current && isLoaded && isSignedIn === false) {
      if (navigation.canGoBack()) {
        navigation.goBack();
      } else {
        navigation.dispatch(StackActions.replace("Settings"));
      }
    }
  }, [isLoaded, isSignedIn, navigation]);

  return (
    <>
      <NativeStackScreenOptions options={{ title: isSignedIn ? "Account" : "Sign in" }} />
      <View collapsable={false} className="flex-1 overflow-hidden bg-sheet">
        {isLoaded ? (
          hasBeenSignedIn.current ? (
            <UserProfileView isDismissible={false} />
          ) : (
            <AuthView isDismissible={false} />
          )
        ) : null}
      </View>
    </>
  );
}
