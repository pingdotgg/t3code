import { AUTH_SCOPE_OPTIONS as PAIRING_SCOPE_OPTIONS } from "@t3tools/shared/authScopeOptions";
import { PlusIcon, QrCodeIcon } from "lucide-react";
import { type ReactNode, memo, useId, useState } from "react";
import {
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  AuthFilesystemReadScope,
  AuthStandardClientScopes,
  AuthTerminalReadScope,
  managedCapabilityDenial,
  type AuthEnvironmentScope,
  type AuthGrantScope,
  type AuthPairingCredentialResult,
  type AdvertisedEndpoint,
} from "@t3tools/contracts";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { formatElapsedDurationLabel, formatExpiresInLabel } from "../../timestampFormat";
import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";
import {
  canRevokeOtherClients,
  isQrShareableEndpoint,
  selectQrEndpointOption,
  togglePairingScopeSelection,
} from "./ConnectionsSettings.logic";
import { useNowSecond } from "../../hooks/useNowSecond";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogFooter,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { QRCodeSvg } from "../ui/qr-code";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import {
  createServerPairingCredential,
  isLoopbackHostname,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
} from "~/environments/primary";
import { readEnvironmentScope } from "~/state/session";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { usePrimaryManagedPolicy } from "~/state/managedPolicy";
import { ManagedControl } from "../ManagedPolicy";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import {
  formatAccessTimestamp,
  selectPairingEndpoint,
  isTailscaleHttpsEndpoint,
  endpointDefaultPreferenceKey,
  resolveAdvertisedEndpointPairingUrl,
  resolveCurrentOriginPairingUrl,
  isHostedAppPairingUrl,
  endpointShareHint,
} from "./ConnectionsSettings.logic";
import type { PairingLinkListRowProps } from "./AuthorizedClientsSettings";
import { AccessScopeSummary } from "./AuthorizedClientsSettings";

export const PairingLinkListRow = memo(function PairingLinkListRow({
  pairingLink,
  credential,
  defaultShareOpen,
  endpointUrl,
  endpoints,
  defaultEndpointKey,
  revokingPairingLinkId,
  onRevoke,
  canRevoke,
}: PairingLinkListRowProps) {
  const nowMs = useNowSecond();
  const expiresAtMs = new Date(pairingLink.expiresAt).getTime();
  const [isRevealDialogOpen, setIsRevealDialogOpen] = useState(false);
  const [isQrPanelOpen, setIsQrPanelOpen] = useState(defaultShareOpen);
  const [qrEndpointId, setQrEndpointId] = useState<string | null>(null);
  const qrPanelId = useId();

  const currentOriginPairingUrl = credential ? resolveCurrentOriginPairingUrl(credential) : null;
  const hostedPairingUrl =
    credential && endpointUrl != null && endpointUrl !== ""
      ? resolveHostedPairingUrl(endpointUrl, credential)
      : null;
  const endpointPairingUrl = (() => {
    const endpoint = selectPairingEndpoint(endpoints, defaultEndpointKey);
    return endpoint && credential
      ? resolveAdvertisedEndpointPairingUrl(endpoint, credential)
      : null;
  })();
  const endpointCopyOptions = (() => {
    const options: Array<{
      readonly id: string;
      readonly preferenceKey: string;
      readonly label: string;
      readonly url: string;
      readonly detail: string;
      readonly qrShareable: boolean;
    }> = [];
    if (!credential) return options;
    for (const endpoint of endpoints) {
      if (endpoint.status === "unavailable") {
        continue;
      }
      const url = resolveAdvertisedEndpointPairingUrl(endpoint, credential);
      options.push({
        id: endpoint.id,
        preferenceKey: endpointDefaultPreferenceKey(endpoint),
        label: endpoint.label,
        url,
        detail: endpointShareHint(endpoint, url),
        qrShareable: isQrShareableEndpoint(endpoint),
      });
    }
    return options;
  })();
  const shareablePairingUrl =
    endpointPairingUrl ??
    (credential && endpointUrl != null && endpointUrl !== ""
      ? (hostedPairingUrl ?? resolveDesktopPairingUrl(endpointUrl, credential))
      : isLoopbackHostname(window.location.hostname)
        ? null
        : currentOriginPairingUrl);
  const [failedCopyValue, setFailedCopyValue] = useState<string | null>(null);
  const revealValue = failedCopyValue ?? shareablePairingUrl ?? credential ?? "";
  const isRevealValueUrl = revealValue !== credential;
  const isRevealValueHostedAppPairingUrl = isRevealValueUrl && isHostedAppPairingUrl(revealValue);
  const isRevealValueQrShareable =
    endpointCopyOptions.find((option) => option.url === revealValue)?.qrShareable ?? true;
  const canCopyToClipboard =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    navigator.clipboard?.writeText != null;

  const { copyToClipboard } = useCopyToClipboard<{
    value: string;
    kind: "code" | "hosted-link" | "link";
  }>({
    onCopy: ({ kind }) => {
      toastManager.add({
        type: "success",
        title:
          kind === "hosted-link"
            ? "Hosted app link copied"
            : kind === "link"
              ? "Pairing URL copied"
              : "Pairing code copied",
        description:
          kind === "hosted-link"
            ? "Open it in the browser on the device you want to connect."
            : kind === "link"
              ? "Open it in the client you want to pair to this environment."
              : "Paste it into another client to finish pairing.",
      });
    },
    onError: (error, { value, kind }) => {
      // Captured per attempt so concurrent copies cannot make the dialog
      // reveal a different value than the one that failed.
      setFailedCopyValue(value);
      setIsRevealDialogOpen(true);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: canCopyToClipboard
            ? kind === "hosted-link"
              ? "Could not copy hosted app link"
              : kind === "link"
                ? "Could not copy pairing URL"
                : "Could not copy pairing code"
            : "Clipboard copy unavailable",
          description: canCopyToClipboard ? error.message : "Showing the full value instead.",
        }),
      );
    },
  });

  const copyPairingValue = (value: string, kind: "code" | "hosted-link" | "link") => {
    copyToClipboard(value, { value, kind });
  };

  const copyKindForUrl = (url: string): "hosted-link" | "link" =>
    isHostedAppPairingUrl(url) ? "hosted-link" : "link";

  const handleCopyCode = () => {
    if (credential) copyPairingValue(credential, "code");
  };

  const expiresAbsolute = formatAccessTimestamp(pairingLink.expiresAt);

  const primaryLabel = pairingLink.label ?? "Pairing link";
  const selectedQrOption = selectQrEndpointOption(
    endpointCopyOptions,
    qrEndpointId,
    defaultEndpointKey,
  );
  const qrPairingUrl = selectedQrOption?.url ?? shareablePairingUrl;
  const canRenderQrForSelection = selectedQrOption?.qrShareable ?? true;
  if (expiresAtMs <= nowMs) {
    return null;
  }

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={`Link created at ${formatAccessTimestamp(pairingLink.createdAt)}`}
              dotClassName="bg-warning"
            />
            <h3 className="text-sm font-medium text-foreground">{primaryLabel}</h3>
          </div>
          <p className="text-xs text-muted-foreground">
            <Tooltip>
              <TooltipTrigger render={<span />}>
                {formatExpiresInLabel(pairingLink.expiresAt, nowMs)}
              </TooltipTrigger>
              <TooltipPopup side="top">{expiresAbsolute}</TooltipPopup>
            </Tooltip>
            <span aria-hidden> · </span>
            <AccessScopeSummary scopes={pairingLink.scopes} label="Pairing link scopes" />
          </p>
          {!credential ? (
            <p className="text-2xs text-muted-foreground/70">
              Create a new link to share from this client.
            </p>
          ) : shareablePairingUrl === null ? (
            <p className="text-2xs text-muted-foreground/70">
              Copy the token and pair from another client using this backend&apos;s reachable host.
            </p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {shareablePairingUrl && canCopyToClipboard ? (
            <Button
              size="xs"
              variant="outline"
              aria-expanded={isQrPanelOpen}
              aria-controls={qrPanelId}
              onClick={() => setIsQrPanelOpen((open) => !open)}
            >
              <QrCodeIcon aria-hidden />
              Share
            </Button>
          ) : null}
          <Dialog
            open={credential !== undefined && isRevealDialogOpen}
            onOpenChange={(open) => {
              setIsRevealDialogOpen(open);
              if (!open) setFailedCopyValue(null);
            }}
          >
            {!credential ? null : canCopyToClipboard ? (
              shareablePairingUrl ? null : (
                <Button size="xs" variant="outline" onClick={handleCopyCode}>
                  Copy code
                </Button>
              )
            ) : (
              <DialogTrigger render={<Button size="xs" variant="outline" />}>
                {shareablePairingUrl ? "Show link" : "Show code"}
              </DialogTrigger>
            )}
            <DialogPopup className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {isRevealValueUrl
                    ? isRevealValueHostedAppPairingUrl
                      ? "Hosted app pairing link"
                      : "Pairing link"
                    : "Pairing code"}
                </DialogTitle>
                <DialogDescription>
                  {isRevealValueUrl
                    ? isRevealValueHostedAppPairingUrl
                      ? "Clipboard copy is unavailable here. Open or manually copy this hosted app link on the device you want to connect."
                      : "Clipboard copy is unavailable here. Open or manually copy this full pairing URL on the device you want to connect."
                    : "Clipboard copy is unavailable here. Manually copy this code into another client."}
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <Textarea
                  readOnly
                  value={revealValue}
                  rows={isRevealValueUrl ? 4 : 3}
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.currentTarget.select()}
                />
                {isRevealValueUrl && isRevealValueQrShareable ? (
                  <div className="flex justify-center rounded-xl border border-border/60 bg-muted/30 p-4">
                    <QRCodeSvg
                      value={revealValue}
                      size={132}
                      level="M"
                      marginSize={2}
                      title="Pairing link. Scan to open on another device"
                    />
                  </div>
                ) : null}
              </DialogPanel>
              <DialogFooter variant="bare">
                <Button variant="outline" onClick={() => setIsRevealDialogOpen(false)}>
                  Done
                </Button>
                {canCopyToClipboard ? (
                  <Button variant="outline" onClick={handleCopyCode}>
                    Copy code
                  </Button>
                ) : null}
              </DialogFooter>
            </DialogPopup>
          </Dialog>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={!canRevoke || revokingPairingLinkId === pairingLink.id}
            onClick={() => void onRevoke(pairingLink.id)}
          >
            {revokingPairingLinkId === pairingLink.id ? "Revoking…" : "Revoke"}
          </Button>
        </div>
      </div>
      {isQrPanelOpen && qrPairingUrl !== null ? (
        <div
          id={qrPanelId}
          className="mt-3 flex flex-col gap-4 border-t border-border/50 pt-3 sm:flex-row sm:items-start sm:justify-between"
        >
          <div className="min-w-0 flex-1 space-y-3">
            {endpointCopyOptions.length > 1 ? (
              <div
                className="space-y-1.5"
                role="radiogroup"
                aria-label="Endpoint the pairing QR code and URL use"
              >
                <p className="text-2xs text-muted-foreground/70">Reach this machine via</p>
                {endpointCopyOptions.map((option) => {
                  const isSelected = option.id === selectedQrOption?.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      className={cn(
                        "flex w-full items-baseline gap-2 rounded-lg border px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        isSelected
                          ? "border-foreground/60 bg-muted/30"
                          : "border-border/50 hover:bg-muted/20",
                      )}
                      onClick={() => setQrEndpointId(option.id)}
                    >
                      <span
                        className={cn(
                          "text-xs font-medium",
                          isSelected ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {option.label}
                      </span>
                      <span className="min-w-0 truncate text-2xs text-muted-foreground/70">
                        {option.detail}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <code className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
                      {qrPairingUrl}
                    </code>
                  }
                />
                <TooltipPopup side="top">{qrPairingUrl}</TooltipPopup>
              </Tooltip>
              <Button
                size="xs"
                variant="ghost"
                className="shrink-0"
                onClick={() => copyPairingValue(qrPairingUrl, copyKindForUrl(qrPairingUrl))}
              >
                Copy link
              </Button>
            </div>
            <Button size="xs" variant="ghost" onClick={handleCopyCode}>
              Copy code only
            </Button>
          </div>
          {canRenderQrForSelection ? (
            <div className="w-fit shrink-0 self-center rounded-xl bg-white p-3 sm:self-start">
              <QRCodeSvg
                value={qrPairingUrl}
                size={168}
                level="M"
                marginSize={1}
                title="Pairing link. Scan to open on another device"
              />
            </div>
          ) : (
            <div className="flex size-[192px] shrink-0 items-center justify-center self-center rounded-xl border border-border/50 p-4 sm:self-start">
              <p className="text-center text-2xs text-muted-foreground/70">
                No QR for this endpoint. Another device scanning a loopback link would dial itself;
                copy the URL for use on this machine instead.
              </p>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
});

