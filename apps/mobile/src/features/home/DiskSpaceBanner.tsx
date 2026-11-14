import { useAtomValue } from "@effect/atom-react";
import { machineDiskSpaceWarnings } from "@t3tools/client-runtime/machine-resources";
import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useServerConfigs } from "../../state/entities";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";

/** The server pushes `diskSpace` only when a level changes, so this never polls. */
export function DiskSpaceBanner() {
  const navigation = useNavigation();
  const configs = useServerConfigs();
  const connected = useAtomValue(connectedEnvironmentIdsAtom);
  const low = connected.flatMap((environmentId) => {
    const config = configs.get(environmentId);
    const warnings = machineDiskSpaceWarnings(
      config?.environment.label ?? environmentId,
      config?.diskSpace,
    );
    return warnings.length === 0 ? [] : [{ environmentId, warnings }];
  });
  if (low.length === 0) return null;
  return (
    <View className="gap-2 px-4 pb-2">
      {low.map(({ environmentId, warnings }) => {
        const critical = warnings.some((warning) => warning.tone === "danger");
        return (
          <Pressable
            key={environmentId}
            accessibilityRole="button"
            accessibilityHint="Opens this environment's settings"
            onPress={() => navigation.navigate("SettingsEnvironmentDetail", { environmentId })}
            className={cn(
              "rounded-2xl border px-3.5 py-3 active:opacity-70",
              critical ? "border-danger-border bg-danger" : "border-warning-border bg-warning",
            )}
          >
            {warnings.map((warning) => (
              <Text
                key={warning.text}
                numberOfLines={2}
                className={cn(
                  "font-t3-medium text-sm",
                  warning.tone === "danger" ? "text-danger-foreground" : "text-warning-foreground",
                )}
              >
                {warning.text}
              </Text>
            ))}
          </Pressable>
        );
      })}
    </View>
  );
}
