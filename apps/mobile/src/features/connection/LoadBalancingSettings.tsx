import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { connectionCatalogDisplayUrl } from "@t3tools/client-runtime/connection";
import { LOAD_PREFERENCES, loadPreferenceForWeight } from "@t3tools/client-runtime/load-balancing";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { environmentCatalog } from "../../connection/catalog";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";

/**
 * Turns auto balance on for this device and sets how often each switched-on
 * machine receives new threads. Hidden until two machines are on, since one
 * machine has nothing to balance against.
 */
export function LoadBalancingSettings() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [expanded, setExpanded] = useState<string | null>(null);
  const entries = [...catalog.entries.values()].filter((entry) => entry.enabled);
  if (entries.length < 2) return null;

  const preferencesReady = AsyncResult.isSuccess(preferencesResult);
  const enabled = preferencesReady && preferencesResult.value.loadBalancingEnabled === true;
  const weights = (preferencesReady ? preferencesResult.value.loadBalancingWeights : null) ?? {};

  return (
    <View className="mt-5 gap-3">
      <SettingsSection title="Load balancing">
        <SettingsSwitchRow
          label="Auto balance"
          value={enabled}
          disabled={!preferencesReady}
          onValueChange={(loadBalancingEnabled) => savePreferences({ loadBalancingEnabled })}
        />
        {entries.map((entry) => {
          const environmentId = entry.target.environmentId;
          const selected = loadPreferenceForWeight(weights[environmentId]);
          const isExpanded = enabled && expanded === environmentId;
          return (
            <View key={environmentId}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${entry.target.label} load preference`}
                accessibilityState={{ expanded: isExpanded, disabled: !enabled }}
                disabled={!enabled}
                className="flex-row items-center gap-3 p-4 disabled:opacity-50"
                onPress={() => setExpanded(isExpanded ? null : environmentId)}
              >
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="text-base font-t3-bold text-foreground">
                    {entry.target.label}
                  </Text>
                  <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                    {connectionCatalogDisplayUrl(entry) ?? "T3 Connect"}
                  </Text>
                </View>
                <Text className="text-sm text-foreground-muted">
                  {LOAD_PREFERENCES.find((preference) => preference.value === selected)?.label}
                </Text>
                <SymbolView
                  name={isExpanded ? "chevron.up" : "chevron.down"}
                  size={12}
                  tintColorClassName="accent-icon-muted"
                />
              </Pressable>
              {isExpanded
                ? LOAD_PREFERENCES.map((preference) => (
                    <Pressable
                      key={preference.value}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected === preference.value }}
                      className="flex-row items-center gap-4 p-4"
                      onPress={() =>
                        savePreferences({
                          transform: (current) => ({
                            loadBalancingWeights: {
                              ...current.loadBalancingWeights,
                              [environmentId]: preference.value,
                            },
                          }),
                        })
                      }
                    >
                      <Text className="min-w-0 flex-1 text-base text-foreground">
                        {preference.label}
                      </Text>
                      {selected === preference.value ? (
                        <SymbolView
                          name="checkmark"
                          size={18}
                          tintColorClassName="accent-icon"
                          weight="semibold"
                        />
                      ) : null}
                    </Pressable>
                  ))
                : null}
            </View>
          );
        })}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        New threads in shared projects start on the machine with the most free CPU and memory,
        weighted by each machine's preference. This applies only to this device.
      </Text>
    </View>
  );
}
