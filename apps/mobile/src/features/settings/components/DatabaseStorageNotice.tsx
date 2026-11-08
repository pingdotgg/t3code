import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { databaseReclaimMinutes, type DatabaseStorageStatus } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Alert } from "react-native";

import { copyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import { ListActionRow as SettingsActionRow } from "../../../components/ui/ListActionRow";
import { SettingsSection } from "./SettingsSection";

const formatGiB = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/** Offers to reclaim the space on every machine whose database still holds at least 1 GiB of freed pages. */
export function DatabaseStorageNotice({
  targets,
}: {
  readonly targets: readonly SettingsTarget[];
}) {
  const recommendations = useAtomValue(
    serverEnvironment.databaseCompactionRecommendations(
      JSON.stringify(targets.map((target) => target.environmentId)),
    ),
  );
  const preferences = useAtomValue(mobilePreferencesAtom);
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  const dismissed = AsyncResult.isSuccess(preferences)
    ? (preferences.value.dismissedDatabaseStorageNotices ?? [])
    : [];
  const visible = recommendations.filter(
    (recommendation) => !dismissed.includes(recommendation.environmentId),
  );
  if (visible.length === 0) return null;
  return (
    <SettingsSection
      title="Reclaim database space"
      footer={`These databases still hold space freed by history cleanup.${
        visible.every((recommendation) => recommendation.status.canReclaim === true)
          ? ""
          : " Run the command on each machine to reclaim it. It restarts the background service. Quit the desktop app first if it hosts the environment."
      }`}
    >
      {visible.map(({ environmentId, status }) => {
        const target = targets.find((candidate) => candidate.environmentId === environmentId);
        return target ? <DatabaseRow key={environmentId} target={target} status={status} /> : null;
      })}
      <SettingsActionRow
        icon="xmark"
        label="Dismiss"
        onPress={() =>
          updatePreferences({
            transform: (current) => ({
              dismissedDatabaseStorageNotices: [
                ...new Set([
                  ...(current.dismissedDatabaseStorageNotices ?? []),
                  ...visible.map((recommendation) => recommendation.environmentId),
                ]),
              ],
            }),
          })
        }
      />
    </SettingsSection>
  );
}

function DatabaseRow({
  target,
  status,
}: {
  readonly target: SettingsTarget;
  readonly status: DatabaseStorageStatus;
}) {
  const { environmentId, label } = target;
  const allowed = useAtomValue(
    serverEnvironment.reclaimDatabaseSpace.permissionAtom(environmentId),
  );
  const reclaim = useAtomCommand(serverEnvironment.reclaimDatabaseSpace, { reportFailure: false });
  const [requested, setRequested] = useState(false);
  const amount = formatGiB(status.reclaimableBytes);
  if (status.canReclaim !== true || !allowed) {
    return (
      <SettingsActionRow
        icon="doc.on.doc"
        label={label}
        description={status.compactCommand}
        detail={amount}
        onPress={() => copyTextWithHaptic(status.compactCommand, { target: "command" })}
      />
    );
  }
  // A failed repair reports back after the restart, which ends the wait.
  const restarting = requested && status.reclaimFailure === undefined;
  const minutes = databaseReclaimMinutes(status);
  const start = async () => {
    setRequested(true);
    const result = await reclaim({ environmentId, input: {} });
    if (result._tag === "Success") return;
    setRequested(false);
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    Alert.alert(
      `Could not reclaim space on ${label}`,
      error instanceof Error ? error.message : "An error occurred.",
    );
  };
  return (
    <SettingsActionRow
      icon="arrow.clockwise"
      label={label}
      description={
        restarting
          ? `Restarting. Back in about ${minutes} min.`
          : status.reclaimFailure === undefined
            ? `Restarts T3 Code there. It is offline for about ${minutes} min.`
            : `The last attempt failed: ${status.reclaimFailure}`
      }
      detail={amount}
      loading={restarting}
      onPress={() =>
        Alert.alert(
          `Reclaim ${amount} on ${label}?`,
          `T3 Code on ${label} stops, rebuilds its database, and starts again. It is offline for about ${minutes} min. Running agents stop when it restarts.`,
          [
            { text: "Cancel", style: "cancel" },
            { text: "Restart and reclaim", onPress: () => void start() },
          ],
        )
      }
    />
  );
}
