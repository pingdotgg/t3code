import { useGT } from "gt-react-native";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { copyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../../state/preferences";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import { ListActionRow as SettingsActionRow } from "../../../components/ui/ListActionRow";
import { SettingsSection } from "./SettingsSection";

/** Suggests `t3 doctor` on every machine whose database still holds at least 1 GiB of freed pages. */
export function DatabaseStorageNotice({
  targets,
}: {
  readonly targets: readonly SettingsTarget[];
}) {
  const gt = useGT();
  const recommendations = useAtomValue(
    serverEnvironment.databaseCompactionRecommendations(
      JSON.stringify(targets.map((target) => target.environmentId)),
    ),
  );
  const preferences = useAtomValue(mobilePreferencesAtom);
  const updatePreferences = useAtomCommand(saveMobilePreferences);
  const dismissed = AsyncResult.isSuccess(preferences)
    ? (preferences.value.dismissedDatabaseStorageNotices ?? [])
    : [];
  const visible = recommendations.filter(
    (recommendation) => !dismissed.includes(recommendation.environmentId),
  );
  if (visible.length === 0) return null;
  return (
    <SettingsSection
      title={gt("Reclaim database space")}
      footer={gt(
        "These databases still hold space freed by history cleanup. Run the command on each machine to reclaim it. It restarts the background service. Quit the desktop app first if it hosts the environment.",
      )}
    >
      {visible.map(({ environmentId, status }) => (
        <SettingsActionRow
          key={environmentId}
          icon="doc.on.doc"
          label={targets.find((target) => target.environmentId === environmentId)?.label ?? ""}
          description={status.compactCommand}
          detail={gt("{size} GiB", { size: (status.reclaimableBytes / 1024 ** 3).toFixed(1) })}
          onPress={() => copyTextWithHaptic(status.compactCommand, { target: "command" })}
        />
      ))}
      <SettingsActionRow
        icon="xmark"
        label={gt("Dismiss")}
        onPress={() => {
          void updatePreferences({
            transform: (current) => ({
              dismissedDatabaseStorageNotices: [
                ...new Set([
                  ...(current.dismissedDatabaseStorageNotices ?? []),
                  ...visible.map((recommendation) => recommendation.environmentId),
                ]),
              ],
            }),
          });
        }}
      />
    </SettingsSection>
  );
}
