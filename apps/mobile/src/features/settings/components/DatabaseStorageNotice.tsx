import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { shouldRecommendDatabaseCompaction } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { copyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import { serverEnvironment } from "../../../state/server";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsActionRow } from "./SettingsActionRow";
import { SettingsSection } from "./SettingsSection";

/** Suggests `t3 doctor` for a database that still holds at least 1 GiB of freed pages. */
export function DatabaseStorageNotice({ target }: { readonly target: SettingsTarget }) {
  const result = useAtomValue(
    serverEnvironment.databaseStorage({ environmentId: target.environmentId, input: {} }),
  );
  const preferences = useAtomValue(mobilePreferencesAtom);
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  const dismissed =
    AsyncResult.isSuccess(preferences) &&
    preferences.value.dismissedDatabaseStorageNotices?.includes(target.environmentId) === true;
  const status = result._tag === "Success" ? result.value : null;
  if (dismissed || status === null || !shouldRecommendDatabaseCompaction(status)) return null;
  const gib = (status.reclaimableBytes / 1024 ** 3).toFixed(1);
  return (
    <SettingsSection title={`Reclaim ${gib} GiB on ${target.label}`}>
      <View className="gap-3 p-4">
        <Text className="text-sm text-muted-foreground">
          Old history is cleaned up automatically, but this database still holds the freed space.
          Run this command on {target.label} to return it to disk; it pauses and restarts the
          background service. Quit the desktop app first if it hosts this environment.
        </Text>
        <Text selectable className="font-mono text-sm text-foreground">
          {status.compactCommand}
        </Text>
      </View>
      <SettingsActionRow
        icon="doc.on.doc"
        label="Copy command"
        onPress={() => copyTextWithHaptic(status.compactCommand, { target: "command" })}
      />
      <SettingsActionRow
        icon="xmark"
        label="Dismiss"
        onPress={() =>
          updatePreferences({
            transform: (current) => ({
              dismissedDatabaseStorageNotices: [
                ...new Set([
                  ...(current.dismissedDatabaseStorageNotices ?? []),
                  target.environmentId,
                ]),
              ],
            }),
          })
        }
      />
    </SettingsSection>
  );
}
