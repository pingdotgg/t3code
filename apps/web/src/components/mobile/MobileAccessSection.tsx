import { SmartphoneIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { AdvertisedEndpoint } from "@t3tools/contracts";

import { createServerPairingCredential } from "~/environments/primary";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { isTailscaleHttpsEndpoint } from "../settings/ConnectionsSettings";
import { resolveAdvertisedEndpointMobileBootstrapUrl } from "../settings/pairingUrls";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";

type MobileAccessSectionProps = {
  endpoints: ReadonlyArray<AdvertisedEndpoint>;
  isTailscaleServeEnabled: boolean;
  isUpdating: boolean;
  onEnable: (endpoint: AdvertisedEndpoint) => void;
  onDisable: (endpoint: AdvertisedEndpoint) => void;
};

export function MobileAccessSection({
  endpoints,
  isTailscaleServeEnabled,
  isUpdating,
  onEnable,
  onDisable,
}: MobileAccessSectionProps) {
  const isMobile = useIsMobile();
  const tailscaleEndpoint = endpoints.find(isTailscaleHttpsEndpoint) ?? null;
  const isReachable = isTailscaleServeEnabled && tailscaleEndpoint?.status === "available";

  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const [isCreatingLink, setIsCreatingLink] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);

  useEffect(() => {
    if (!isReachable || !tailscaleEndpoint) {
      setPairingUrl(null);
      setPairingError(null);
      return;
    }

    let cancelled = false;
    setIsCreatingLink(true);
    setPairingError(null);

    createServerPairingCredential("Mobile")
      .then((link) => {
        if (cancelled) return;
        setPairingUrl(
          resolveAdvertisedEndpointMobileBootstrapUrl(tailscaleEndpoint, link.credential),
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPairingError(error instanceof Error ? error.message : "Failed to create pairing link.");
      })
      .finally(() => {
        if (!cancelled) setIsCreatingLink(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isReachable, tailscaleEndpoint]);

  const canToggle = tailscaleEndpoint !== null;
  const description = canToggle
    ? "Expose this session over your tailnet so you can install T3 Code on your phone and pick up sessions on the go."
    : "Install Tailscale on this machine to enable a private mobile connection.";

  return (
    <SettingsSection title="Mobile access" icon={<SmartphoneIcon className="size-3.5" />}>
      <SettingsRow
        title="Connect from your phone"
        description={description}
        control={
          <Switch
            checked={isTailscaleServeEnabled}
            disabled={!canToggle || isUpdating}
            aria-label="Enable mobile access via Tailscale"
            onCheckedChange={(checked) => {
              if (!tailscaleEndpoint) return;
              if (checked) onEnable(tailscaleEndpoint);
              else onDisable(tailscaleEndpoint);
            }}
          />
        }
      />
      {isReachable && tailscaleEndpoint ? (
        <div
          data-testid="mobile-access-reachable-panel"
          className="border-t border-border/60 px-4 py-4 sm:px-5"
        >
          {isCreatingLink ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              Creating pairing link…
            </div>
          ) : pairingError ? (
            <p className="text-xs text-destructive">{pairingError}</p>
          ) : pairingUrl ? (
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <div
                className="shrink-0 rounded-lg border border-border/60 bg-white p-2"
                data-testid="mobile-access-qr-frame"
              >
                <QRCodeSvg
                  value={pairingUrl}
                  size={isMobile ? 220 : 132}
                  level="M"
                  marginSize={2}
                  title="Scan to open T3 Code on your phone"
                />
              </div>
              <div className="min-w-0 space-y-1.5">
                <p className="text-xs font-medium text-foreground">
                  Scan with your phone&apos;s camera
                </p>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Opens T3 Code on your phone — installs the app if needed and connects to this
                  session. Single-use; expires in 24 hours.
                </p>
                <p className="truncate font-mono text-[10px] text-muted-foreground/60">
                  {tailscaleEndpoint.httpBaseUrl}
                </p>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </SettingsSection>
  );
}
