import { useAuth } from "@clerk/expo";
import { Redirect, Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback } from "react";
import { ScrollView } from "react-native";

import { CloudWaitlistEnrollment } from "../../features/cloud/CloudWaitlistEnrollment";
import { useClerkSettingsSheetDetent } from "../../features/cloud/ClerkSettingsSheetDetent";
import { hasCloudPublicConfig } from "../../features/cloud/publicConfig";

export default function SettingsWaitlistRouteScreen() {
  return hasCloudPublicConfig() ? (
    <ConfiguredSettingsWaitlistRouteScreen />
  ) : (
    <Redirect href="/settings" />
  );
}

function ConfiguredSettingsWaitlistRouteScreen() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { expand } = useClerkSettingsSheetDetent();
  const router = useRouter();

  useFocusEffect(
    useCallback(() => {
      if (isLoaded && isSignedIn) {
        router.replace("/settings");
      }
    }, [isLoaded, isSignedIn, router]),
  );

  return (
    <>
      <Stack.Screen options={{ title: "Join the waitlist" }} />
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
            router.push("/settings/auth");
          }}
        />
      </ScrollView>
    </>
  );
}
