import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  pullRequestRoutingConnectionKey,
  pullRequestRoutingPermissionFor,
  type PullRequestRoutingPermission,
} from "@t3tools/client-runtime/connection";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { environmentCatalog } from "../../connection/catalog";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

const options: ReadonlyArray<{
  value: PullRequestRoutingPermission;
  label: string;
  description: string;
}> = [
  { value: "off", label: "Off", description: "Keep source control requests on this environment." },
  {
    value: "read",
    label: "Read PRs",
    description: "Share PR data with other enabled environments.",
  },
  {
    value: "read-write",
    label: "Read and act",
    description:
      "Actions may use broader source control permissions than the original environment.",
  },
];

export function PullRequestRoutingSettings() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const permissions = useAtomValue(environmentCatalog.pullRequestRoutingPermissionsValueAtom);
  const update = useAtomCommand(environmentCatalog.setPullRequestRoutingPermission);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (catalog.entries.size === 0) return null;

  return (
    <View className="mt-5 gap-3">
      <SettingsSection title="Pull request routing">
        {[...catalog.entries.values()].map((entry) => {
          const environmentId = entry.target.environmentId;
          const selected = pullRequestRoutingPermissionFor(entry, permissions);
          const disabled =
            !catalog.isReady || saving || pullRequestRoutingConnectionKey(entry) === null;
          return (
            <View key={environmentId}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${entry.target.label} pull request routing`}
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
                    <ListChoiceRow
                      key={option.value}
                      label={option.label}
                      description={option.description}
                      selected={selected === option.value}
                      disabled={disabled}
                      onPress={() => {
                        setSaving(true);
                        void update({ environmentId, permission: option.value }).then((result) => {
                          setSaving(false);
                          if (result._tag === "Failure")
                            Dialog.alert(
                              "Could not save pull request routing permission",
                              "Try again before leaving this screen.",
                            );
                        });
                      }}
                    />
                  ))
                : null}
            </View>
          );
        })}
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Choose environments you trust to share PR data and use each other's source control access.
        Enable both environments. This applies only to this client.
      </Text>
    </View>
  );
}
