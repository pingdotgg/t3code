import { useState } from "react";
import { useTranslation } from "react-i18next";

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
import { Checkbox } from "../ui/checkbox";
import { Spinner } from "../ui/spinner";

export interface ConnectDeviceRevokeRequest {
  readonly title: string;
  /** Revokes the device; resolves once the attempt finished, failed or not. */
  readonly revoke: () => Promise<void>;
}

/**
 * With approval off, a revoked T3 Connect device signs straight back in, so revoking offers to
 * turn approval on first.
 */
export function RevokeConnectDeviceDialog({
  request,
  onClose,
  requireApproval,
}: {
  readonly request: ConnectDeviceRevokeRequest | null;
  readonly onClose: () => void;
  /** Saves the setting; resolves false when the save failed. */
  readonly requireApproval: () => Promise<boolean>;
}) {
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {request ? (
        <RevokeConnectDeviceDialogPopup
          key={request.title}
          request={request}
          onClose={onClose}
          requireApproval={requireApproval}
        />
      ) : null}
    </AlertDialog>
  );
}

function RevokeConnectDeviceDialogPopup({
  request,
  onClose,
  requireApproval,
}: {
  readonly request: ConnectDeviceRevokeRequest;
  readonly onClose: () => void;
  readonly requireApproval: () => Promise<boolean>;
}) {
  const { t } = useTranslation("settings");
  const [turnOnApproval, setTurnOnApproval] = useState(true);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    if (turnOnApproval && !(await requireApproval())) {
      setBusy(false);
      return;
    }
    await request.revoke();
    setBusy(false);
    onClose();
  };

  return (
    <AlertDialogPopup>
      <AlertDialogHeader>
        <AlertDialogTitle>{request.title}</AlertDialogTitle>
        <AlertDialogDescription>
          Approval for new devices is off, so a revoked device signed in to your T3 Connect account
          can connect again on its own.
        </AlertDialogDescription>
        <label className="mt-2 flex cursor-pointer items-start gap-3">
          <Checkbox
            className="mt-0.5"
            checked={turnOnApproval}
            disabled={busy}
            onCheckedChange={(checked) => setTurnOnApproval(checked === true)}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              {t("connectDevice.requireApproval")}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t("connectDevice.approvalHint")}
            </span>
          </span>
        </label>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogClose disabled={busy} render={<Button variant="outline" disabled={busy} />}>
          {t("connectDevice.cancel")}
        </AlertDialogClose>
        <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
          {busy && <Spinner size="sm" />}
          {t("connectDevice.revoke")}
        </Button>
      </AlertDialogFooter>
    </AlertDialogPopup>
  );
}
