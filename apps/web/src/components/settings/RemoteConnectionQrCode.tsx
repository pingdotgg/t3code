import QRCode from "qrcode";
import { useEffect, useState } from "react";

export function RemoteConnectionQrCode({ value, alt }: { value: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    setSrc(null);
    setHasError(false);

    void QRCode.toDataURL(value, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 220,
    })
      .then((dataUrl) => {
        if (cancelled) {
          return;
        }
        setSrc(dataUrl);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setHasError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [value]);

  if (hasError) {
    return (
      <div className="flex size-56 items-center justify-center rounded-2xl border border-dashed border-border bg-muted/20 px-4 text-center text-xs text-muted-foreground">
        Could not generate the QR code.
      </div>
    );
  }

  if (!src) {
    return (
      <div className="flex size-56 items-center justify-center rounded-2xl border border-border bg-muted/20 px-4 text-center text-xs text-muted-foreground">
        Generating QR…
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className="size-56 rounded-2xl border border-border bg-white p-3 shadow-xs"
    />
  );
}
