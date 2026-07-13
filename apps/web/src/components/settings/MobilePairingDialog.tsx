import { formatExpiresInLabel } from "../../timestampFormat";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { QRCodeSvg } from "../ui/qr-code";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import type { MobilePairingDialogState } from "./useMobilePairing";
import { useState } from "react";

function PairingExpirationLabel({ expiresAt }: { readonly expiresAt: string }) {
  const [nowMs] = useState(() => Date.now());
  return <>{formatExpiresInLabel(expiresAt, nowMs)}.</>;
}

export function MobilePairingDialog({
  state,
  open,
  onOpenChange,
}: {
  readonly state: MobilePairingDialogState | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Pairing payload copied",
        description: "Paste it into T3 Mobile if camera scanning is unavailable.",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Connect new device</DialogTitle>
          <DialogDescription>
            Open T3 Mobile, tap Connect, and scan this QR code. The mobile app will save this
            connection after the first successful sync.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {state ? (
            <>
              <div className="flex justify-center rounded-xl border border-border/60 bg-white p-4">
                <QRCodeSvg
                  value={state.payload}
                  size={220}
                  level="M"
                  marginSize={3}
                  title="T3 Mobile pairing QR code"
                />
              </div>
              <div className="space-y-1.5 text-xs text-muted-foreground">
                <p>
                  Server: <span className="font-mono text-foreground">{state.endpointUrl}</span>
                </p>
                <p>
                  <PairingExpirationLabel
                    key={state.pairingCredential.expiresAt}
                    expiresAt={state.pairingCredential.expiresAt}
                  />
                </p>
              </div>
              <Textarea
                readOnly
                value={state.payload}
                rows={4}
                className="text-xs leading-relaxed"
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
              />
            </>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
          {state ? (
            <Button variant="outline" onClick={() => copyToClipboard(state.payload, undefined)}>
              {isCopied ? "Copied" : "Copy fallback"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
