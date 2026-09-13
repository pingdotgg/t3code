import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  gitHubRoutingConnectionKey,
  gitHubRoutingPermissionFor,
  type GitHubRoutingPermission,
} from "@t3tools/client-runtime/connection";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { environmentCatalog } from "../../connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

const options: ReadonlyArray<{
  value: GitHubRoutingPermission;
  label: string;
  description: string;
}> = [
  { value: "off", label: "Off", description: "Keep GitHub requests on this environment." },
  {
    value: "read",
    label: "Read PRs",
    description: "Share PR data with other enabled environments.",
  },
  {
    value: "read-write",
    label: "Read and act",
    description: "Actions may use broader GitHub permissions than the original environment.",
  },
];

export function GitHubRoutingSettings() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const permissions = useAtomValue(environmentCatalog.githubRoutingPermissionsValueAtom);
  const update = useAtomCommand(environmentCatalog.setGitHubRoutingPermission);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (catalog.entries.size === 0) return null;

  return (
    <View className="mt-5 gap-3">
      <SettingsSection title="GitHub routing">
        {[...catalog.entries.values()].map((entry, index) => {
          const environmentId = entry.target.environmentId;
          const selected = gitHubRoutingPermissionFor(entry, permissions);
          const disabled = !catalog.isReady || saving || gitHubRoutingConnectionKey(entry) === null;
          return (
            <View
              key={environmentId}
              className={index === 0 ? undefined : "border-t border-border-subtle"}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${entry.target.label} GitHub routing`}
                accessibilityState={{ expanded: expanded === environmentId }}
                className="flex-row items-center gap-3 p-4"
                onPress={() => setExpanded(expanded === environmentId ? null : environmentId)}
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
                  {options.find((option) => option.value === selected)?.label}
                </Text>
                <SymbolView
                  name={expanded === environmentId ? "chevron.up" : "chevron.down"}
                  size={12}
                  tintColorClassName="accent-icon-muted"
                />
              </Pressable>
              {expanded === environmentId
                ? options.map((option) => (
                    <Pressable
                      key={option.value}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected === option.value, disabled }}
                      disabled={disabled}
                      className="flex-row items-center gap-4 border-t border-border-subtle p-4 disabled:opacity-50"
                      onPress={() => {
                        setSaving(true);
                        void update({ environmentId, permission: option.value }).then((result) => {
                          setSaving(false);
                          if (result._tag === "Failure")
                            Alert.alert(
                              "Could not save GitHub routing permission",
                              "Try again before leaving this screen.",
                            );
                        });
                      }}
                    >
                      <View className="min-w-0 flex-1 gap-1">
                        <Text className="text-base text-foreground">{option.label}</Text>
                        <Text className="text-sm leading-normal text-foreground-muted">
                          {option.description}
                        </Text>
                      </View>
                      {selected === option.value ? (
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
        Choose environments you trust to share PR data and use each other's GitHub access. Enable
        both environments. This applies only to this client.
      </Text>
    </View>
  );
}
