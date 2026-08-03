import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { selectProviderAuthSetupCandidates } from "@t3tools/client-runtime/state/provider-auth";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useRef } from "react";
import { Alert } from "react-native";

import { useServerConfigs } from "../../state/entities";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function ProviderAuthSetupCoordinator() {
  const navigation = useNavigation();
  const configs = useServerConfigs();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const hasPresentedPromptRef = useRef(false);

  useEffect(() => {
    if (!AsyncResult.isSuccess(preferences)) return;
    const dismissed = preferences.value.providerAuthSetupDismissedEnvironmentIds ?? [];
    const candidate = [...configs.entries()].find(
      ([environmentId, config]) =>
        !dismissed.includes(environmentId) &&
        selectProviderAuthSetupCandidates(config.providers).length > 0,
    );
    if (!candidate || hasPresentedPromptRef.current) return;
    const environmentId = candidate[0];
    hasPresentedPromptRef.current = true;
    const finish = async () => {
      try {
        await savePreferences({
          providerAuthSetupDismissedEnvironmentIds: [...new Set([...dismissed, environmentId])],
        });
      } catch {
        hasPresentedPromptRef.current = false;
      }
    };
    Alert.alert(
      "Connect your coding agents",
      "Sign in to provider CLIs from T3 Code. Credentials stay in the selected environment.",
      [
        { text: "Later", style: "cancel", onPress: () => void finish() },
        {
          text: "Set up",
          onPress: () => {
            navigation.navigate("SettingsSheet", { screen: "SettingsProviders" });
          },
        },
      ],
    );
  }, [configs, navigation, preferences, savePreferences]);

  return null;
}
