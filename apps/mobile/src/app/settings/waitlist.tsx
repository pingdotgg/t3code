import { Redirect, Stack } from "expo-router";
import { ScrollView } from "react-native";

import { CloudWaitlistEnrollment } from "../../features/cloud/CloudWaitlistEnrollment";
import { hasCloudPublicConfig } from "../../features/cloud/publicConfig";
import { useNativeClerkAuthModal } from "../../features/cloud/useNativeClerkAuthModal";

export default function SettingsWaitlistRouteScreen() {
  return hasCloudPublicConfig() ? (
    <ConfiguredSettingsWaitlistRouteScreen />
  ) : (
    <Redirect href="/settings" />
  );
}

function ConfiguredSettingsWaitlistRouteScreen() {
  const { presentAuth } = useNativeClerkAuthModal();

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
        <CloudWaitlistEnrollment onSignIn={() => void presentAuth()} />
      </ScrollView>
    </>
  );
}
