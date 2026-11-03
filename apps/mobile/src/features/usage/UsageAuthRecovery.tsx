import { useNavigation } from "@react-navigation/native";
import { AuthProvidersManageScope, type EnvironmentId, type UsageSource } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useEnvironmentScope } from "../../state/session";

export function UsageAuthRecovery({
  environmentId,
  label,
  source,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly source: UsageSource;
}) {
  const navigation = useNavigation();
  const permitted = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  return source.authRecovery?.map((target) => (
    <View key={target.kind === "cursorCli" ? "cli" : target.instanceId} className="gap-2">
      <Text className="text-sm text-foreground-muted">
        {label}: {source.message ?? "Sign-in needs attention."}
      </Text>
      {target.kind === "cursorCli" ? (
        <>
          <Text className="text-sm text-foreground-muted">
            Run cursor-agent login on {label}, then refresh Usage.
          </Text>
          <Button
            label="Copy sign-in command"
            size="compact"
            disabled={!permitted}
            onPress={() => void Clipboard.setStringAsync("cursor-agent login")}
          />
        </>
      ) : target.kind === "apiKey" ? (
        <Text className="text-sm text-foreground-muted">
          Update CURSOR_API_KEY for {target.instanceId} on {label} in web or desktop Settings →
          Providers.
        </Text>
      ) : (
        <Button
          label="Sign in again"
          size="compact"
          disabled={!permitted}
          onPress={() =>
            navigation.navigate("SettingsProviderAccounts", {
              environmentId,
              instanceId: target.instanceId,
            })
          }
        />
      )}
    </View>
  ));
}
