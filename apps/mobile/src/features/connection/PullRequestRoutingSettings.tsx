import { msg, useGT, useMessages } from "gt-react-native";
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
  {
    value: "off",
    label: msg("Off", { $context: "pull request routing permission" }),
    description: msg("Keep source control requests on this environment."),
  },
  {
    value: "read",
    label: msg("Read PRs"),
    description: msg("Share PR data with other enabled environments."),
  },
  {
    value: "read-write",
    label: msg("Read and act"),
    description: msg(
      "Actions may use broader source control permissions than the original environment.",
    ),
  },
];

export function PullRequestRoutingSettings() {
  const gt = useGT();
  const m = useMessages();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const permissions = useAtomValue(environmentCatalog.pullRequestRoutingPermissionsValueAtom);
  const update = useAtomCommand(environmentCatalog.setPullRequestRoutingPermission);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (catalog.entries.size === 0) return null;

  return (
    <View className="mt-5">
      <SettingsSection
        title="Pull request routing"
        footer="Environments you trust share PR data and source control access. Both must be on; applies only to this client."
      >
        {[...catalog.entries.values()].map((entry) => {
          const environmentId = entry.target.environmentId;
          const selected = pullRequestRoutingPermissionFor(entry, permissions);
          const disabled =
            !catalog.isReady || saving || pullRequestRoutingConnectionKey(entry) === null;
          return (
            <View key={environmentId}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={gt("{environment} pull request routing", {
                  environment: entry.target.label,
                })}
                accessibilityState={{ expanded: expanded === environmentId }}
                className="flex-row items-center gap-3 p-4"
                onPress={() => setExpanded(expanded === environmentId ? null : environmentId)}
              >
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="text-base font-t3-bold text-foreground">
                    {entry.target.label}
                  </Text>
                  {connectionCatalogDisplayUrl(entry) === null ? null : (
                    <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                      {connectionCatalogDisplayUrl(entry)}
                    </Text>
                  )}
                </View>
                <Text className="text-sm text-foreground-muted">
                  {m(options.find((option) => option.value === selected)?.label ?? "")}
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
                      label={m(option.label)}
                      description={m(option.description)}
                      selected={selected === option.value}
                      disabled={disabled}
                      onPress={() => {
                        setSaving(true);
                        void update({ environmentId, permission: option.value }).then((result) => {
                          setSaving(false);
                          if (result._tag === "Failure")
                            Dialog.alert(
                              gt("Could not save pull request routing permission"),
                              gt("Try again before leaving this screen."),
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
    </View>
  );
}
