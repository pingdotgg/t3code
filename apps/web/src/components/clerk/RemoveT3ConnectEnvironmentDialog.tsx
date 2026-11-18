import { useAtomValue } from "@effect/atom-react";
import { Discovery, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { useState } from "react";

import { deregisterManagedRelayEnvironmentCommand } from "../../cloud/managedRelayState";
import { useRelayEnvironmentDiscovery } from "../../state/environments";
import { relayEnvironmentDiscovery } from "../../state/relay";
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
import { Button, InlineButton } from "../ui/button";
import { useCloudAuth, useT3ConnectAccountPage } from "../../cloud/cloudAuth";

export function RemoveT3ConnectEnvironmentDialog({
  environmentLabel,
  environmentId,
  onCancel,
  onConfirm,
}: {
  readonly environmentLabel: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const accountPage = useT3ConnectAccountPage();
  const { provider } = useCloudAuth();
  const gt = useGT();
  const session = useAtomValue(managedRelaySessionAtom);
  const deregister = useAtomCommand(deregisterManagedRelayEnvironmentCommand, {
    label: "deregister environment",
  });
  const refreshDiscovery = useAtomCommand(relayEnvironmentDiscovery.refreshAfterMutation, {
    reportFailure: false,
  });
  const [isDeregistering, setIsDeregistering] = useState(false);
  const discovery = useRelayEnvironmentDiscovery();
  const registration = environmentId
    ? Discovery.relayEnvironmentRegistration(discovery, environmentId)
    : "unknown";
  const [shown, setShown] = useState({ label: environmentLabel, registration });
  if (
    environmentLabel !== null &&
    (environmentLabel !== shown.label || registration !== shown.registration)
  ) {
    setShown({ label: environmentLabel, registration });
  }
  // A self-hosted relay frees no host space, so leaving it there only makes it come back.
  const removesEverywhere =
    provider === "oidc" && shown.registration === "registered" && session !== null;
  const removeEverywhere = async () => {
    if (session === null || environmentId === null) return;
    setIsDeregistering(true);
    const result = await deregister({ accountId: session.accountId, environmentId });
    setIsDeregistering(false);
    if (result._tag === "Failure") return;
    void refreshDiscovery();
    onConfirm();
  };
  const openAccountPage = accountPage.open;
  const accountPageLink = openAccountPage ? (
    <InlineButton
      onClick={() => {
        onCancel();
        openAccountPage();
      }}
    >
      <T>T3 Connect settings</T>
    </InlineButton>
  ) : (
    gt("T3 Connect settings")
  );

  return (
    <>
      <AlertDialog
        open={environmentLabel !== null}
        onOpenChange={(open) => {
          if (!open) onCancel();
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removesEverywhere ? (
                <T>
                  Remove <Var>{shown.label}</Var>?
                </T>
              ) : (
                <T>
                  Remove <Var>{shown.label}</Var> from this device?
                </T>
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>This forgets its pairing, credentials, and cached threads here.</T>
            </AlertDialogDescription>
            <AlertDialogDescription>
              {removesEverywhere ? (
                gt(
                  "It's also removed from your relay account, so it doesn't come back on your devices.",
                )
              ) : shown.registration === "registered" ? (
                <T>
                  It stays on your T3 Connect account and keeps its host space. Deregister it in{" "}
                  <Var>{accountPageLink}</Var> to free it.
                </T>
              ) : shown.registration === "unregistered" ? (
                gt("It's no longer on your T3 Connect account.")
              ) : (
                <T>
                  This doesn't change your T3 Connect account. To deregister it there, use{" "}
                  <Var>{accountPageLink}</Var>.
                </T>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            {removesEverywhere ? (
              <Button
                variant="destructive"
                disabled={isDeregistering}
                onClick={() => void removeEverywhere()}
              >
                {isDeregistering ? gt("Removing…") : gt("Remove")}
              </Button>
            ) : (
              <Button variant="destructive" onClick={onConfirm}>
                <T>Remove from this device</T>
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {accountPage.portals}
    </>
  );
}
