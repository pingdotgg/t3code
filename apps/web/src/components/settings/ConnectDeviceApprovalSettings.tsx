import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { AuthConnectDevice, EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as DateTime from "effect/DateTime";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";

import type { ServerPairingLinkRecord } from "~/environments/primary";
import { authEnvironment } from "~/state/auth";
import { m } from "~/i18n/messages";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  connectDeviceName,
  describeConnectDeviceClient,
  formatAccessTimestamp,
} from "./ConnectionsSettings.logic";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { SettingsSection } from "./settingsLayout";

function reportFailure(title: string, result: Parameters<typeof isAtomCommandInterrupted>[0]) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description:
        error instanceof Error
          ? (thrownErrorMessage(error, m) ?? error.message)
          : m(msg("An error occurred.")),
    }),
  );
}

export function ConnectDeviceApprovalSettings({
  environmentId,
  requests,
  devices,
  canWrite,
  requestRevoke,
}: {
  readonly environmentId: EnvironmentId;
  readonly requests: ReadonlyArray<ServerPairingLinkRecord>;
  readonly devices: ReadonlyArray<AuthConnectDevice>;
  readonly canWrite: boolean;
  /** Revokes now, or first asks to turn approval on when it is off. */
  readonly requestRevoke: (title: string, revoke: () => Promise<void>) => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const approve = useAtomCommand(authEnvironment.approveConnectDevice, { reportFailure: false });
  const deny = useAtomCommand(authEnvironment.revokePairingLink, { reportFailure: false });
  const revoke = useAtomCommand(authEnvironment.revokeConnectDevice, { reportFailure: false });
  const [busyId, setBusyId] = useState<string | null>(null);

  const run = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    await action();
    setBusyId(null);
  };

  return (
    <SettingsSection id="connect-devices" title={gt("T3 Connect devices")}>
      {requests.map((request) => {
        const connectRequest = request.connectDeviceRequest;
        if (!connectRequest) return null;
        const busy = busyId === request.id;
        return (
          <div key={request.id} className={ITEM_ROW_CLASSNAME}>
            <div className={ITEM_ROW_INNER_CLASSNAME}>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-medium text-foreground">
                  <T>
                    Waiting for approval ·{" "}
                    <span className="font-mono tabular-nums">
                      <Var>{connectRequest.verificationCode}</Var>
                    </span>
                  </T>
                </p>
                <p className="text-xs text-muted-foreground">
                  <T>
                    <Var>{describeConnectDeviceClient(connectRequest, resolve)}</Var>. Approve only
                    if the device in front of you shows this code.
                  </T>
                </p>
              </div>
              <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={!canWrite || busy}
                  onClick={() =>
                    void run(request.id, async () =>
                      reportFailure(
                        gt("Could not deny the device"),
                        await deny({ environmentId, input: { id: request.id } }),
                      ),
                    )
                  }
                >
                  <T>Deny</T>
                </Button>
                <Button
                  size="xs"
                  disabled={!canWrite || busy}
                  onClick={() =>
                    void run(request.id, async () =>
                      reportFailure(
                        gt("Could not approve the device"),
                        await approve({ environmentId, input: { pairingLinkId: request.id } }),
                      ),
                    )
                  }
                >
                  {busy ? gt("Saving…") : gt("Approve")}
                </Button>
              </div>
            </div>
          </div>
        );
      })}
      {devices.map((device) => {
        const busy = busyId === device.proofKeyThumbprint;
        return (
          <div key={device.proofKeyThumbprint} className={ITEM_ROW_CLASSNAME}>
            <div className={ITEM_ROW_INNER_CLASSNAME}>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-medium text-foreground">
                  {describeConnectDeviceClient(device, resolve)}
                </p>
                <p className="text-xs text-muted-foreground">
                  <span className="font-mono tabular-nums">{device.verificationCode}</span>
                  <span aria-hidden> · </span>
                  <T>
                    Trusted since{" "}
                    <Var>{formatAccessTimestamp(DateTime.formatIso(device.approvedAt))}</Var>
                  </T>
                </p>
              </div>
              <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={!canWrite || busy}
                  onClick={() =>
                    requestRevoke(
                      gt("Revoke {name}?", { name: connectDeviceName(device, resolve) }),
                      () =>
                        run(device.proofKeyThumbprint, async () =>
                          reportFailure(
                            gt("Could not revoke the device"),
                            await revoke({
                              environmentId,
                              input: { proofKeyThumbprint: device.proofKeyThumbprint },
                            }),
                          ),
                        ),
                    )
                  }
                >
                  {busy ? gt("Revoking…") : gt("Revoke")}
                </Button>
              </div>
            </div>
          </div>
        );
      })}
      {devices.length === 0 && requests.length === 0 ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-xs text-muted-foreground/60">
            <T>No device has connected through T3 Connect yet.</T>
          </p>
        </div>
      ) : null}
    </SettingsSection>
  );
}
