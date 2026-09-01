import { useAuth } from "@clerk/expo";
import { AuthView, UserProfileView } from "@clerk/expo/native";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { useCloudAuthLoadState } from "../cloud/CloudAuthProvider";
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
  const { remount } = useCloudAuthLoadState();
  const navigation = useNavigation();
  const handleHostBack = useCallback(
    () => navigation.dispatch(StackActions.popTo("SettingsContent")),
    [navigation],
  );
  const hasBeenSignedIn = useRef(isSignedIn);
  if (isSignedIn) {
    hasBeenSignedIn.current = true;
  }

  useEffect(() => {
    if (hasBeenSignedIn.current && isLoaded && isSignedIn === false) {
      navigation.dispatch(StackActions.popTo("SettingsContent"));
    }
  }, [isLoaded, isSignedIn, navigation]);

  return (
    <View collapsable={false} className="flex-1 overflow-hidden bg-sheet">
      {isLoaded ? (
        hasBeenSignedIn.current ? (
          <UserProfileView isDismissible={false} onHostBack={handleHostBack} />
        ) : (
          <AuthView isDismissible={false} onHostBack={handleHostBack} />
        )
      ) : (
        <ClerkLoadPendingView onRetry={remount} />
      )}
    </View>
  );
}

function ClerkLoadPendingView(props: { readonly onRetry: () => void }) {
  const iconColor = useThemeColor("--color-icon");

  return (
    <View collapsable={false} className="flex-1 items-center justify-center gap-4 px-8">
      <ActivityIndicator color={iconColor} />
      <Text className="text-center text-base font-t3-bold text-foreground">
        Checking T3 Account
      </Text>
      <Text className="text-center text-sm leading-normal text-foreground-muted">
        T3 Account is still loading. Retry without clearing app data.
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={props.onRetry}
        className="rounded-full bg-subtle px-4 py-2 active:opacity-70"
      >
        <Text className="text-xs font-t3-bold text-foreground">Retry</Text>
      </Pressable>
    </View>
  );
}
