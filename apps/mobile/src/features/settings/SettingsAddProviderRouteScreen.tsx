import { AuthProvidersManageScope, EnvironmentId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentsWithScope } from "../../state/session";
import { ClaudeAccountForm } from "./ClaudeAccounts";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

/** Claude-only add form; other drivers open instance settings from the Providers Add menu. */
export function SettingsAddProviderRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
}>) {
  const { environmentId } = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const environment = selectedTargets.find((target) => target.environmentId === environmentId);
  const permitted = useEnvironmentsWithScope(
    environment ? [environment] : [],
    AuthProvidersManageScope,
  ).has(environmentId);

  if (!environment) {
    return (
      <SettingsScreen title="Add Claude">
        <View className="flex-1 items-center justify-center px-5">
          <Text className="text-foreground-muted">This environment is no longer available.</Text>
        </View>
      </SettingsScreen>
    );
  }

  if (!permitted) {
    return (
      <SettingsScreen title="Add Claude">
        <View className="flex-1 items-center justify-center gap-1 px-5">
          <Text className="text-base text-foreground">Limited permissions</Text>
          <Text className="text-center text-sm text-foreground-muted">
            {`This session can view ${environment.label}'s providers but can't change their settings.`}
          </Text>
        </View>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title="Add Claude">
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title={environment.label}>
          <ClaudeAccountForm
            environment={environment}
            instanceId={null}
            initial={{ name: "", configDir: "" }}
            onDone={() => navigation.goBack()}
          />
        </SettingsSection>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
