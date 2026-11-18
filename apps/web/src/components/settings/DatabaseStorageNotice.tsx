import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  databaseReclaimMinutes,
  type DatabaseStorageStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg, T, useGT, Var } from "gt-react";
import { type ReactNode, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { appName } from "@t3tools/shared/appName";

const DismissedEnvironmentIds = Schema.Array(Schema.String);
const reclaimPermissionsAtom = environmentAtomList(
  "web-database-reclaim-permissions",
  serverEnvironment.reclaimDatabaseSpace.permissionAtom,
);

const formatGiB = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

/** Offers to reclaim the space on every machine whose database still holds at least 1 GiB of freed pages. */
export function DatabaseStorageNotice({
  environments,
}: {
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>;
}) {
  const gt = useGT();
  const environmentIds = environments.map((environment) => environment.environmentId);
  const recommendations = useAtomValue(
    serverEnvironment.databaseCompactionRecommendations(JSON.stringify(environmentIds)),
  );
  const permissions = useAtomValue(reclaimPermissionsAtom(environmentIdsKey(environmentIds)));
  const [dismissed, setDismissed] = useLocalStorage(
    "database-storage-notice-dismissed",
    [],
    DismissedEnvironmentIds,
  );
  const { copyToClipboard } = useCopyToClipboard({
    target: {
      target: "command",
      unavailableMessage: msg("Clipboard API is unavailable while copying command."),
      failureMessage: msg("Failed to copy command to the clipboard."),
    },
  });
  const visible = recommendations
    .filter((recommendation) => !dismissed.includes(recommendation.environmentId))
    .map((recommendation) => ({
      ...recommendation,
      label:
        environments.find(
          (environment) => environment.environmentId === recommendation.environmentId,
        )?.label ?? recommendation.environmentId,
      reclaimable:
        recommendation.status.canReclaim === true &&
        permissions[environmentIds.indexOf(recommendation.environmentId)] === true,
    }));
  if (visible.length === 0) return null;
  return (
    <SettingsSection id="storage-database" title={gt("Database")}>
      <SettingsRow
        title={gt("Reclaim freed database space")}
        description={
          visible.every((recommendation) => recommendation.reclaimable)
            ? gt("These databases still hold space freed by history cleanup.")
            : gt(
                "These databases still hold space freed by history cleanup. Run the command on each machine to reclaim it. It restarts the background service. Quit the desktop app first if it hosts the environment.",
              )
        }
      />
      {visible.map(({ environmentId, status, label, reclaimable }) => {
        const dismiss = (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setDismissed((current) => [...current, environmentId])}
          >
            <T>Dismiss</T>
          </Button>
        );
        return reclaimable ? (
          <ReclaimRow
            key={environmentId}
            environmentId={environmentId}
            label={label}
            status={status}
            dismiss={dismiss}
          />
        ) : (
          <SettingsRow
            key={environmentId}
            title={gt("{amount} on {environment}", {
              amount: formatGiB(status.reclaimableBytes),
              environment: label,
            })}
            description={<code className="select-text break-all">{status.compactCommand}</code>}
            control={
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => copyToClipboard(status.compactCommand, undefined)}
                >
                  <T>Copy command</T>
                </Button>
                {dismiss}
              </div>
            }
          />
        );
      })}
    </SettingsSection>
  );
}

function ReclaimRow({
  environmentId,
  label,
  status,
  dismiss,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly status: DatabaseStorageStatus;
  readonly dismiss: ReactNode;
}) {
  const gt = useGT();
  const reclaim = useAtomCommand(serverEnvironment.reclaimDatabaseSpace);
  const [confirming, setConfirming] = useState(false);
  const [requested, setRequested] = useState(false);
  // A failed repair reports back after the restart, which ends the wait.
  const restarting = requested && status.reclaimFailure === undefined;
  const minutes = databaseReclaimMinutes(status);
  const amount = formatGiB(status.reclaimableBytes);
  const start = async () => {
    setConfirming(false);
    setRequested(true);
    const result = await reclaim({ environmentId, input: {} });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Reclaiming {amount} on {environment}", { amount, environment: label }),
        description: gt("{appName} there restarts and is back in about {minutes} min.", {
          appName: appName(),
          minutes,
        }),
      });
      return;
    }
    setRequested(false);
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: gt("Could not reclaim space on {environment}", { environment: label }),
      description:
        error instanceof Error
          ? (thrownErrorMessage(error, m) ?? error.message)
          : gt("An error occurred."),
    });
  };
  return (
    <SettingsRow
      title={gt("{amount} on {environment}", { amount, environment: label })}
      description={
        status.reclaimFailure === undefined
          ? gt("Restarts {appName} there. It will be offline for about {minutes} min.", {
              appName: appName(),
              minutes,
            })
          : gt("The last attempt failed: {reason}", { reason: status.reclaimFailure })
      }
      control={
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            size="xs"
            disabled={restarting}
            onClick={() => setConfirming(true)}
          >
            {restarting ? gt("Restarting…") : gt("Reclaim")}
          </Button>
          {dismiss}
          <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  <T>
                    Reclaim <Var>{amount}</Var> on <Var>{label}</Var>?
                  </T>
                </AlertDialogTitle>
                <AlertDialogDescription>
                  <T>
                    <Var>{appName()}</Var> on <Var>{label}</Var> stops, rebuilds its database, and
                    starts again. It will be offline for about <Var>{minutes}</Var> min. Running
                    agents stop when it restarts.
                  </T>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="outline" />}>
                  <T>Cancel</T>
                </AlertDialogClose>
                <Button onClick={() => void start()}>
                  <T>Restart and reclaim</T>
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </div>
      }
    />
  );
}
