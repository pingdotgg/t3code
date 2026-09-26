import { CopyIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { formatExpiresInLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { QRCodeSvg } from "../ui/qr-code";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useRelativeTimeTick } from "./settingsLayout";

/**
 * A freshly minted one-time code (Tailcat connection code, federation peer
 * code): the text, a copy button, its QR, and a live countdown. Ticks only
 * while a code is on screen.
 */
export const OneTimeCodeReveal = memo(function OneTimeCodeReveal({
  code,
  expiresAt,
  label,
  copiedDescription,
  expiredMessage,
  footer,
}: {
  readonly code: string;
  readonly expiresAt: string;
  /** Names the code in the field, the QR, and the copy toasts, e.g. "Peer code". */
  readonly label: string;
  /** Where to paste the code, shown once it is copied. */
  readonly copiedDescription: string;
  readonly expiredMessage: string;
  readonly footer?: ReactNode;
}) {
  const nowMs = useRelativeTimeTick(1_000);
  const { copyToClipboard } = useCopyToClipboard<void>({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: `${label} copied`,
        description: copiedDescription,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not copy ${label.toLowerCase()}`,
          description: error.message,
        }),
      );
    },
  });

  if (Date.parse(expiresAt) <= nowMs) {
    return <p className="text-xs text-muted-foreground">{expiredMessage}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-2">
          <Textarea
            readOnly
            value={code}
            rows={4}
            aria-label={label}
            font="mono"
            className="break-all"
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => event.currentTarget.select()}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" variant="outline" onClick={() => copyToClipboard(code)}>
              <CopyIcon aria-hidden />
              Copy code
            </Button>
            <span className="text-2xs text-muted-foreground">
              {formatExpiresInLabel(expiresAt, nowMs)} · single use
            </span>
          </div>
        </div>
        <div className="w-fit shrink-0 self-center rounded-xl bg-white p-3 sm:self-start">
          <QRCodeSvg value={code} size={168} level="L" marginSize={1} title={label} />
        </div>
      </div>
      {footer}
    </div>
  );
});
