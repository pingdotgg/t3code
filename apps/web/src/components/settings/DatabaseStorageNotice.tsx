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
import { type ReactNode, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useT } from "../../hooks/useI18n";
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
  const t = useT();
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
  const { copyToClipboard } = useCopyToClipboard({ target: "command" });
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
    <SettingsSection id="storage-database" title={t("settings.system.dbNotice.title")}>
      <SettingsRow
        title={t("settings.system.dbNotice.reclaim.title")}
        description={`${t("settings.system.dbNotice.reclaim.description")}${
          visible.every((recommendation) => recommendation.reclaimable)
            ? ""
            : t("settings.system.dbNotice.reclaim.manualSteps")
        }`}
      />
      {visible.map(({ environmentId, status, label, reclaimable }) => {
        const dismiss = (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setDismissed((current) => [...current, environmentId])}
          >
            {t("settings.system.dbNotice.dismiss")}
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
            title={t("settings.system.dbNotice.row.title", {
              size: formatGiB(status.reclaimableBytes),
              label,
            })}
            description={<code className="select-text break-all">{status.compactCommand}</code>}
            control={
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => copyToClipboard(status.compactCommand, undefined)}
                >
                  {t("settings.system.dbNotice.copyCommand")}
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
  const t = useT();
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
        title: t("settings.system.dbNotice.reclaimRow.successTitle", { amount, label }),
        description: t("settings.system.dbNotice.reclaimRow.successDescription", { minutes }),
      });
      return;
    }
    setRequested(false);
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: t("settings.system.dbNotice.reclaimRow.failureTitle", { label }),
      description:
        error instanceof Error ? error.message : t("settings.system.dbNotice.reclaimRow.error"),
    });
  };
  return (
    <SettingsRow
      title={t("settings.system.dbNotice.row.title", { size: amount, label })}
      description={
        status.reclaimFailure === undefined
          ? t("settings.system.dbNotice.reclaimRow.offline", { minutes })
          : t("settings.system.dbNotice.reclaimRow.lastFailed", { reason: status.reclaimFailure })
      }
      control={
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            size="xs"
            disabled={restarting}
            onClick={() => setConfirming(true)}
          >
            {restarting
              ? t("settings.system.dbNotice.reclaimRow.restarting")
              : t("settings.system.dbNotice.reclaimRow.reclaim")}
          </Button>
          {dismiss}
          <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("settings.system.dbNotice.reclaimRow.confirmTitle", { amount, label })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("settings.system.dbNotice.reclaimRow.confirmDescription", { label, minutes })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="outline" />}>
                  {t("settings.system.dbNotice.reclaimRow.cancel")}
                </AlertDialogClose>
                <Button onClick={() => void start()}>
                  {t("settings.system.dbNotice.reclaimRow.confirm")}
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </div>
      }
    />
  );
}
