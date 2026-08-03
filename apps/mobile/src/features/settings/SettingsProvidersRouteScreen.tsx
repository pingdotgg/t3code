import { useNavigation } from "@react-navigation/native";
import type {
  EnvironmentId,
  ProviderAuthAction,
  ProviderAuthSessionId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { Alert, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useServerConfigs } from "../../state/entities";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import type { ProviderAuthRouteParams } from "./providerAuthRoute";

function authPresentation(provider: {
  readonly auth: { readonly status: string; readonly email?: string };
  readonly authManagement?: {
    readonly activeSession: {
      readonly sessionId: ProviderAuthSessionId;
      readonly action: ProviderAuthAction;
    } | null;
  };
}): { readonly label: string; readonly action: ProviderAuthAction } {
  if (provider.authManagement?.activeSession) {
    return { label: "Continue", action: provider.authManagement.activeSession.action };
  }
  if (provider.auth.status === "authenticated") {
    return { label: provider.auth.email ?? "Signed in", action: "signOut" };
  }
  return { label: "Sign in", action: "signIn" };
}

export function SettingsProvidersRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const configs = useServerConfigs();
  const { environments } = useEnvironments();
  const environmentLabels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Provider accounts" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {[...configs.entries()].map(([environmentId, config]) => {
          const manageable = config.providers.filter((provider) => provider.authManagement);
          if (manageable.length === 0) return null;
          return (
            <SettingsSection
              key={environmentId}
              title={environmentLabels.get(environmentId) ?? "Environment"}
            >
              {manageable.map((provider) => {
                const presentation = authPresentation(provider);
                const activeSession = provider.authManagement?.activeSession;
                const displayName = provider.displayName ?? provider.driver;
                const openAuthentication = () =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsProviderAuth",
                    params: {
                      environmentId: environmentId as EnvironmentId,
                      instanceId: provider.instanceId as ProviderInstanceId,
                      displayName,
                      action: presentation.action,
                      ...(activeSession ? { sessionId: activeSession.sessionId } : {}),
                    } satisfies ProviderAuthRouteParams,
                  });
                return (
                  <SettingsRow
                    key={provider.instanceId}
                    icon="person.badge.key"
                    label={displayName}
                    value={presentation.label}
                    disabled={
                      activeSession === null &&
                      (presentation.action === "signIn"
                        ? provider.authManagement?.canSignIn !== true
                        : provider.authManagement?.canSignOut !== true)
                    }
                    onPress={() => {
                      if (presentation.action !== "signOut" || activeSession) {
                        openAuthentication();
                        return;
                      }
                      Alert.alert(
                        `Sign out of ${displayName}?`,
                        "This removes the provider credentials from this environment only.",
                        [
                          { text: "Cancel", style: "cancel" },
                          { text: "Sign out", style: "destructive", onPress: openAuthentication },
                        ],
                      );
                    }}
                  />
                );
              })}
            </SettingsSection>
          );
        })}
      </ScrollView>
    </View>
  );
}
