import { useAuth } from "@clerk/expo";
import {
  NavigateTo,
  NativeStackScreenOptions,
  useFocusEffect,
  useAppNavigation,
} from "../../navigation/native-stack-header";
import { useCallback } from "react";
import { ScrollView } from "react-native";

import { CloudWaitlistEnrollment } from "../../features/cloud/CloudWaitlistEnrollment";
import { useClerkSettingsSheetDetent } from "../../features/cloud/ClerkSettingsSheetDetent";
import { hasCloudPublicConfig } from "../../features/cloud/publicConfig";
import { settingsAuthNavigation, settingsNavigation } from "../../lib/routes";

export default function SettingsWaitlistRouteScreen() {
  return hasCloudPublicConfig() ? (
    <ConfiguredSettingsWaitlistRouteScreen />
  ) : (
    <NavigateTo href={settingsNavigation()} />
  );
}

function ConfiguredSettingsWaitlistRouteScreen() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { expand } = useClerkSettingsSheetDetent();
  const navigation = useAppNavigation();

  useFocusEffect(
    useCallback(() => {
      if (isLoaded && isSignedIn) {
        navigation.replace(settingsNavigation());
      }
    }, [isLoaded, isSignedIn, navigation]),
  );

  return (
    <>
      <NativeStackScreenOptions options={{ title: "Join the waitlist" }} />
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{
          paddingBottom: 32,
          paddingHorizontal: 20,
          paddingTop: 12,
        }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <CloudWaitlistEnrollment
          onSignIn={() => {
            expand();
            navigation.push(settingsAuthNavigation());
          }}
        />
      </ScrollView>
    </>
  );
}
