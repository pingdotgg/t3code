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

function AccessScopeSummary({
  scopes,
  label,
}: {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly label: string;
}) {
  const scopeCountLabel = `${scopes.length} ${scopes.length === 1 ? "scope" : "scopes"}`;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={250}
        closeDelay={100}
        render={
          <button
            type="button"
            aria-label={`${label}: show ${scopeCountLabel}`}
            className="cursor-help underline decoration-border underline-offset-2 outline-hidden hover:text-foreground focus-visible:text-foreground"
          />
        }
      >
        {scopeCountLabel}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        tooltipStyle
        className="w-max max-w-80 whitespace-normal"
      >
        <p className="mb-1 font-medium">Granted scopes</p>
        <div className="flex flex-col gap-0.5">
          {scopes.map((scope) => (
            <code key={scope} className="font-mono text-foreground/85">
              {scope}
            </code>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function endpointRowClassName(isAvailable: boolean) {
  return cn(
    "relative first:rounded-t-xl last:rounded-b-xl px-3 py-3 sm:px-4",
    !isAvailable && "bg-muted/15",
  );
}

type PairingLinkListRowProps = {
  pairingLink: ServerPairingLinkRecord;
  credential: string | undefined;
  endpointUrl: string | null | undefined;
  endpoints: ReadonlyArray<AdvertisedEndpoint>;
  defaultEndpointKey: string | null;
  revokingPairingLinkId: string | null;
  onRevoke: (id: string) => void;
  canRevoke: boolean;
};

const PairingLinkListRow = memo(function PairingLinkListRow({
  pairingLink,
  credential,
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
  const [isQrPanelOpen, setIsQrPanelOpen] = useState(false);
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

type ConnectedClientListRowProps = {
  clientSession: ServerClientSessionRecord;
  revokingClientSessionId: string | null;
  onRevokeSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
  canRevoke: boolean;
};

const ConnectedClientListRow = memo(function ConnectedClientListRow({
  clientSession,
  revokingClientSessionId,
  onRevokeSession,
  canRevoke,
}: ConnectedClientListRowProps) {
  const nowMs = useNowSecond();
  const isLive = clientSession.current || clientSession.connected;
  const lastConnectedAt = clientSession.lastConnectedAt;
  const statusTooltip = isLive
    ? lastConnectedAt
      ? `Connected for ${formatElapsedDurationLabel(lastConnectedAt, nowMs)}`
      : "Connected"
    : lastConnectedAt
      ? `Last connected at ${formatAccessTimestamp(lastConnectedAt)}`
      : "Not connected yet.";
  const deviceInfoBits = [
    clientSession.client.deviceType !== "unknown"
      ? clientSession.client.deviceType[0]?.toUpperCase() + clientSession.client.deviceType.slice(1)
      : null,
    clientSession.client.os ?? null,
    clientSession.client.browser ?? null,
    clientSession.client.ipAddress ?? null,
  ].filter((value): value is string => value !== null);
  const primaryLabel =
    clientSession.client.label ??
    ([clientSession.client.os, clientSession.client.browser].filter(Boolean).join(" · ") ||
      clientSession.subject);

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={statusTooltip}
              dotClassName={isLive ? "bg-success" : "bg-muted-foreground/30"}
              pingClassName={isLive ? "bg-success/60 duration-2000" : null}
            />
            <h3 className="text-sm font-medium text-foreground">{primaryLabel}</h3>
            {clientSession.current ? (
              <span className="text-3xs text-muted-foreground/80 rounded-md border border-border/50 bg-muted/50 px-1 py-0.5">
                This device
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {deviceInfoBits.length > 0 ? (
              <>
                {deviceInfoBits.join(" · ")}
                <span aria-hidden> · </span>
              </>
            ) : null}
            <AccessScopeSummary scopes={clientSession.scopes} label="Client scopes" />
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {!clientSession.current ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={!canRevoke || revokingClientSessionId === clientSession.sessionId}
              onClick={() => void onRevokeSession(clientSession.sessionId)}
            >
              {revokingClientSessionId === clientSession.sessionId ? "Revoking…" : "Revoke"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

type AuthorizedClientsHeaderActionProps = {
  onPairingLinkCreated: (result: AuthPairingCredentialResult) => void;
  clientSessions: ReadonlyArray<ServerClientSessionRecord> | null;
  isRevokingOtherClients: boolean;
  onRevokeOtherClients: () => void;
  delegatableScopes: ReadonlyArray<AuthEnvironmentScope>;
};

export const AuthorizedClientsHeaderAction = memo(function AuthorizedClientsHeaderAction({
  onPairingLinkCreated,
  clientSessions,
  isRevokingOtherClients,
  onRevokeOtherClients,
  delegatableScopes,
}: AuthorizedClientsHeaderActionProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pairingLabel, setPairingLabel] = useState("");
  const [pairingScopes, setPairingScopes] = useState<ReadonlyArray<AuthGrantScope>>([
    ...AuthStandardClientScopes,
  ]);
  const selectedScopes = pairingScopes.filter((scope) => delegatableScopes.includes(scope));
  const [isCreatingPairingLink, setIsCreatingPairingLink] = useState(false);

  const handleCreatePairingLink = async () => {
    if (
      primaryEnvironmentId === null ||
      selectedScopes.length === 0 ||
      !readEnvironmentScope(primaryEnvironmentId, AuthAccessWriteScope) ||
      !selectedScopes.every((scope) => readEnvironmentScope(primaryEnvironmentId, scope))
    )
      return;
    setIsCreatingPairingLink(true);
    const settled = await settlePromise(async () => {
      const created = await createServerPairingCredential({
        label: pairingLabel,
        scopes: selectedScopes,
      });
      onPairingLinkCreated(created);
      setPairingLabel("");
      setPairingScopes(
        AuthStandardClientScopes.filter((scope) => delegatableScopes.includes(scope)),
      );
      setDialogOpen(false);
    });
    if (settled._tag === "Failure") {
      const error = Cause.squash(settled.cause);
      const message = error instanceof Error ? error.message : "Failed to create pairing URL.";
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create pairing URL",
          description: message,
        }),
      );
    }
    setIsCreatingPairingLink(false);
  };

  const togglePairingScope = (scope: AuthGrantScope, checked: boolean) => {
    setPairingScopes((current) => togglePairingScopeSelection(current, scope, checked));
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={isRevokingOtherClients || !canRevokeOtherClients(clientSessions)}
        onClick={() => void onRevokeOtherClients()}
      >
        {isRevokingOtherClients ? "Revoking…" : "Revoke others"}
      </Button>
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setPairingLabel("");
            setPairingScopes(
              AuthStandardClientScopes.filter((scope) => delegatableScopes.includes(scope)),
            );
          }
        }}
      >
        <DialogTrigger
          render={
            <Button size="xs" variant="default">
              <PlusIcon className="size-3" />
              Create link
            </Button>
          }
        />
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create pairing link</DialogTitle>
            <DialogDescription>
              Generate a one-time link that another device can use to pair with this backend as an
              authorized client.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Client label (optional)
              </span>
              <Input
                value={pairingLabel}
                onChange={(event) => setPairingLabel(event.target.value)}
                placeholder="e.g. Living room iPad"
                disabled={isCreatingPairingLink}
                autoFocus
              />
            </label>
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-xs font-medium text-foreground">Permissions</h3>
                  <p className="text-xs text-muted-foreground">
                    Limit what the paired client can do.
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={isCreatingPairingLink}
                    onClick={() =>
                      setPairingScopes(
                        [
                          AuthOrchestrationReadScope,
                          AuthFilesystemReadScope,
                          AuthDiagnosticsReadScope,
                          AuthTerminalReadScope,
                        ].filter((scope) => delegatableScopes.includes(scope)),
                      )
                    }
                  >
                    Read only
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={isCreatingPairingLink}
                    onClick={() =>
                      setPairingScopes(
                        AuthStandardClientScopes.filter((scope) =>
                          delegatableScopes.includes(scope),
                        ),
                      )
                    }
                  >
                    Standard
                  </Button>
                </div>
              </div>
              <div className="divide-y divide-border/60 rounded-lg border border-input bg-muted/25">
                {PAIRING_SCOPE_OPTIONS.filter(({ scope }) => delegatableScopes.includes(scope)).map(
                  ({ scope, title, description }) => (
                    <label
                      key={scope}
                      className="flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={pairingScopes.includes(scope)}
                        disabled={isCreatingPairingLink}
                        onCheckedChange={(checked) => togglePairingScope(scope, checked === true)}
                      />
                      <span className="min-w-0">
                        <span className="block text-xs font-medium text-foreground">{title}</span>
                        <span className="block text-xs leading-snug text-muted-foreground">
                          {description}
                        </span>
                      </span>
                    </label>
                  ),
                )}
              </div>
              {selectedScopes.length === 0 ? (
                <p className="text-xs text-destructive">Select at least one permission.</p>
              ) : selectedScopes.includes(AuthAccessWriteScope) ? (
                <p className="text-xs text-warning">
                  This client can create or revoke access for other devices.
                </p>
              ) : null}
            </section>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              variant="outline"
              disabled={isCreatingPairingLink}
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={isCreatingPairingLink || selectedScopes.length === 0}
              onClick={() => void handleCreatePairingLink()}
            >
              {isCreatingPairingLink ? "Creating…" : "Create link"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});

type PairingClientsListProps = {
  endpointUrl: string | null | undefined;
  endpoints: ReadonlyArray<AdvertisedEndpoint>;
  defaultEndpointKey: string | null;
  isLoading: boolean;
  pairingLinks: ReadonlyArray<ServerPairingLinkRecord>;
  createdPairingCredentials: ReadonlyMap<string, string>;
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  revokingPairingLinkId: string | null;
  revokingClientSessionId: string | null;
  onRevokePairingLink: (id: string) => void;
  onRevokeClientSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
  canRevoke: boolean;
};

export const PairingClientsList = memo(function PairingClientsList({
  endpointUrl,
  endpoints,
  defaultEndpointKey,
  isLoading,
  pairingLinks,
  createdPairingCredentials,
  clientSessions,
  revokingPairingLinkId,
  revokingClientSessionId,
  onRevokePairingLink,
  onRevokeClientSession,
  canRevoke,
}: PairingClientsListProps) {
  return (
    <>
      {pairingLinks.map((pairingLink) => (
        <PairingLinkListRow
          key={pairingLink.id}
          pairingLink={pairingLink}
          credential={createdPairingCredentials.get(pairingLink.id)}
          endpointUrl={endpointUrl}
          endpoints={endpoints}
          defaultEndpointKey={defaultEndpointKey}
          revokingPairingLinkId={revokingPairingLinkId}
          onRevoke={onRevokePairingLink}
          canRevoke={canRevoke}
        />
      ))}

      {clientSessions.map((clientSession) => (
        <ConnectedClientListRow
          key={clientSession.sessionId}
          clientSession={clientSession}
          revokingClientSessionId={revokingClientSessionId}
          onRevokeSession={onRevokeClientSession}
          canRevoke={canRevoke}
        />
      ))}

      {pairingLinks.length === 0 && clientSessions.length === 0 && !isLoading ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-xs text-muted-foreground/60">No pairing links or client sessions.</p>
        </div>
      ) : null}
    </>
  );
});

type AdvertisedEndpointListRowProps = {
  endpoint: AdvertisedEndpoint;
  isDefault: boolean;
  onSetDefault: (endpoint: AdvertisedEndpoint) => void;
  onSetupTailscaleServe: (endpoint: AdvertisedEndpoint) => void;
  onDisableTailscaleServe: (endpoint: AdvertisedEndpoint) => void;
  isUpdatingTailscaleServe: boolean;
};

export const AdvertisedEndpointListRow = memo(function AdvertisedEndpointListRow({
  endpoint,
  isDefault,
  onSetDefault,
  onSetupTailscaleServe,
  onDisableTailscaleServe,
  isUpdatingTailscaleServe,
}: AdvertisedEndpointListRowProps) {
  const isAvailable = endpoint.status === "available";
  const needsTailscaleSetup = isTailscaleHttpsEndpoint(endpoint) && endpoint.status !== "available";
  const canDisableTailscaleServe =
    isTailscaleHttpsEndpoint(endpoint) && endpoint.status === "available";
  const shouldShowEndpointUrl = !needsTailscaleSetup;
  return (
    <div className={endpointRowClassName(isAvailable)}>
      {isDefault ? (
        <span className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-primary" aria-hidden />
      ) : null}
      <div className="flex min-h-6 min-w-0 flex-col gap-2 sm:-my-0.5 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-baseline gap-3">
          <h3 className="shrink-0 text-sm leading-5 font-medium text-foreground">
            {endpoint.label}
          </h3>
          {shouldShowEndpointUrl ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <p className="min-w-0 truncate text-xs leading-5 text-muted-foreground">
                    {endpoint.httpBaseUrl}
                  </p>
                }
              />
              <TooltipPopup side="top">{endpoint.httpBaseUrl}</TooltipPopup>
            </Tooltip>
          ) : null}
          {!isAvailable ? (
            <span className="shrink-0 rounded-md border border-border/70 px-1 py-0.5 text-3xs text-muted-foreground">
              Setup required
            </span>
          ) : null}
        </div>
        <div className="ml-auto flex min-h-6 shrink-0 items-center justify-end gap-2">
          {isDefault ? (
            <span className="rounded-md border border-primary/30 bg-primary/10 px-1 py-0.5 text-3xs text-primary">
              Default
            </span>
          ) : null}
          {needsTailscaleSetup ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => onSetupTailscaleServe(endpoint)}
              disabled={isUpdatingTailscaleServe}
            >
              {isUpdatingTailscaleServe ? "Restarting…" : "Setup"}
            </Button>
          ) : null}
          {canDisableTailscaleServe ? (
            <Button
              size="xs"
              variant="destructive-outline"
              onClick={() => onDisableTailscaleServe(endpoint)}
              disabled={isUpdatingTailscaleServe}
            >
              {isUpdatingTailscaleServe ? "Restarting…" : "Disable"}
            </Button>
          ) : null}
          {!needsTailscaleSetup && !isDefault ? (
            <Button size="xs" variant="outline" onClick={() => onSetDefault(endpoint)}>
              Set as default
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

export function NetworkAccessDescription({
  endpoint,
  hiddenEndpointCount,
  expanded,
  onToggleExpanded,
  fallback,
}: {
  endpoint: AdvertisedEndpoint | null;
  hiddenEndpointCount: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  fallback: ReactNode;
}) {
  if (!endpoint) {
    return fallback;
  }

  const summary = (
    <>
      <span className="min-w-0 truncate">{endpoint.httpBaseUrl}</span>
      {hiddenEndpointCount > 0 ? (
        <span className="shrink-0 text-xs font-medium">
          {expanded ? "Hide" : `+${hiddenEndpointCount}`}
        </span>
      ) : null}
    </>
  );

  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1">
      <span className="shrink-0">Reachable at</span>
      {hiddenEndpointCount > 0 ? (
        <button
          type="button"
          className="inline-flex min-w-0 max-w-full items-baseline gap-2 border-b border-dotted border-muted-foreground/60 text-left text-muted-foreground underline-offset-4 hover:border-foreground hover:text-foreground"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
        >
          {summary}
        </button>
      ) : (
        <span className="inline-flex min-w-0 max-w-full items-baseline gap-2">{summary}</span>
      )}
    </span>
  );
}
