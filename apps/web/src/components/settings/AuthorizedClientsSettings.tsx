import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m as resolveMessage } from "~/i18n/messages";
import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import { AUTH_SCOPE_OPTIONS as PAIRING_SCOPE_OPTIONS } from "@t3tools/shared/authScopeOptions";
import {
  PlugIcon,
  CheckIcon,
  CopyIcon,
  MonitorIcon,
  QrCodeIcon,
  SmartphoneIcon,
  TabletIcon,
} from "lucide-react";
import { memo, useId, useState } from "react";
import { msg, T, useGT, useMessages } from "gt-react";
import {
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  AuthFilesystemReadScope,
  AuthRelayConfigureScope,
  AuthStandardClientScopes,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type AuthEnvironmentScope,
  type AuthGrantScope,
  type AuthPairingCredentialResult,
  type AdvertisedEndpoint,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

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
import { SettingsRow, SettingsRowTile } from "./settingsLayout";
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
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
} from "~/environments/primary";
import { authEnvironment } from "~/state/auth";
import { readEnvironmentScope } from "~/state/session";
import { useManagedPolicy, usePrimaryManagedPolicy } from "~/state/managedPolicy";
import { useAtomCommand } from "~/state/use-atom-command";
import { ManagedControl } from "../ManagedPolicy";
import { openUseInAnotherApp } from "../mcp/UseInAnotherAppDialog";
import { StatusDot } from "../ui/status-dot";
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
  const gt = useGT();
  const scopeCountLabel = gt("{count, plural, one {{count} scope} other {{count} scopes}}", {
    count: scopes.length,
  });

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={250}
        closeDelay={100}
        render={
          <button
            type="button"
            aria-label={gt("{label}: show {scopes}", { label, scopes: scopeCountLabel })}
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
        <p className="mb-1 font-medium">
          <T>Granted scopes</T>
        </p>
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
    "relative first:rounded-t-card-inner last:rounded-b-card-inner px-3 py-3 sm:px-4",
    !isAvailable && "bg-muted/15",
  );
}

type PairingLinkListRowProps = {
  pairingLink: ServerPairingLinkRecord;
  credential: string | undefined;
  defaultShareOpen: boolean;
  /** Whether this page is served by the environment the link pairs with. */
  servedByEnvironment: boolean;
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
  defaultShareOpen,
  servedByEnvironment,
  endpointUrl,
  endpoints,
  defaultEndpointKey,
  revokingPairingLinkId,
  onRevoke,
  canRevoke,
}: PairingLinkListRowProps) {
  const gt = useGT();
  const m = useMessages();
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
        detail: endpointShareHint(endpoint, url, m),
        qrShareable: isQrShareableEndpoint(endpoint),
      });
    }
    return options;
  })();
  const shareablePairingUrl =
    endpointPairingUrl ??
    (credential && endpointUrl != null && endpointUrl !== ""
      ? (hostedPairingUrl ?? resolveDesktopPairingUrl(endpointUrl, credential))
      : servedByEnvironment
        ? currentOriginPairingUrl
        : null);
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
              ? gt("Could not copy hosted app link")
              : kind === "link"
                ? gt("Could not copy pairing URL")
                : gt("Could not copy pairing code")
            : gt("Clipboard copy unavailable"),
          description: canCopyToClipboard ? error.message : gt("Showing the full value instead."),
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

  const primaryLabel = pairingLink.label ?? gt("Pairing link");
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
            <StatusDot
              size="md"
              tone="warning"
              label={gt("Link created at {time}", {
                time: formatAccessTimestamp(pairingLink.createdAt),
              })}
            />
            <h3 className="text-label text-strong-foreground">{primaryLabel}</h3>
          </div>
          <p className="grid justify-items-start gap-1 text-meta text-muted-foreground">
            <Tooltip>
              <TooltipTrigger render={<span />}>
                {formatExpiresInLabel(pairingLink.expiresAt, nowMs, m)}
              </TooltipTrigger>
              <TooltipPopup side="top">{expiresAbsolute}</TooltipPopup>
            </Tooltip>
            <AccessScopeSummary scopes={pairingLink.scopes} label={gt("Pairing link scopes")} />
          </p>
          {!credential ? (
            <p className="text-caption text-dim-foreground">
              <T>Create a new link to share from this client.</T>
            </p>
          ) : shareablePairingUrl === null ? (
            <p className="text-caption text-dim-foreground">
              <T>
                Copy the token and pair from another client using this backend&apos;s reachable
                host.
              </T>
            </p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {shareablePairingUrl && canCopyToClipboard ? (
            <Button
              size="xs"
              variant="secondary"
              aria-expanded={isQrPanelOpen}
              aria-controls={qrPanelId}
              onClick={() => setIsQrPanelOpen((open) => !open)}
            >
              <QrCodeIcon aria-hidden />
              <T>Share</T>
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
                <Button size="xs" variant="secondary" onClick={handleCopyCode}>
                  <T>Copy code</T>
                </Button>
              )
            ) : (
              <DialogTrigger render={<Button size="xs" variant="secondary" />}>
                {shareablePairingUrl ? gt("Show link") : gt("Show code")}
              </DialogTrigger>
            )}
            <DialogPopup className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {isRevealValueUrl
                    ? isRevealValueHostedAppPairingUrl
                      ? gt("Hosted app pairing link")
                      : gt("Pairing link")
                    : gt("Pairing code")}
                </DialogTitle>
                <DialogDescription>
                  {isRevealValueUrl
                    ? isRevealValueHostedAppPairingUrl
                      ? gt(
                          "Clipboard copy is unavailable here. Open or manually copy this hosted app link on the device you want to connect.",
                        )
                      : gt(
                          "Clipboard copy is unavailable here. Open or manually copy this full pairing URL on the device you want to connect.",
                        )
                    : gt(
                        "Clipboard copy is unavailable here. Manually copy this code into another client.",
                      )}
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
                  <div className="flex justify-center rounded-card border border-transparent surface-card-settings p-4">
                    <QRCodeSvg
                      value={revealValue}
                      size={132}
                      level="M"
                      marginSize={2}
                      title={gt("Pairing link. Scan to open on another device")}
                    />
                  </div>
                ) : null}
              </DialogPanel>
              <DialogFooter variant="bare">
                <Button variant="secondary" onClick={() => setIsRevealDialogOpen(false)}>
                  <T>Done</T>
                </Button>
                {canCopyToClipboard ? (
                  <Button variant="secondary" onClick={handleCopyCode}>
                    <T>Copy code</T>
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
            {revokingPairingLinkId === pairingLink.id ? gt("Revoking…") : gt("Revoke")}
          </Button>
        </div>
      </div>
      {isQrPanelOpen && qrPairingUrl !== null ? (
        <div
          id={qrPanelId}
          className="mt-3 flex flex-col gap-4 border-t border-border pt-3 sm:flex-row sm:items-start sm:justify-between"
        >
          <div className="min-w-0 flex-1 space-y-3">
            {endpointCopyOptions.length > 1 ? (
              <div
                className="space-y-1.5"
                role="radiogroup"
                aria-label={gt("Endpoint the pairing QR code and URL use")}
              >
                <p className="text-caption text-dim-foreground">
                  <T>Reach this machine via</T>
                </p>
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
                          ? "border-ring surface-selected"
                          : "border-border hover:surface-ghost-hover",
                      )}
                      onClick={() => setQrEndpointId(option.id)}
                    >
                      <span
                        className={cn(
                          "text-meta",
                          isSelected ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {option.label}
                      </span>
                      <span className="min-w-0 truncate text-caption text-dim-foreground">
                        {option.detail}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="flex items-center gap-2 rounded-control surface-well px-2.5 py-1.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <code className="min-w-0 flex-1 truncate font-mono text-caption text-muted-foreground">
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
                <T>Copy link</T>
              </Button>
            </div>
            <Button size="xs" variant="ghost" onClick={handleCopyCode}>
              <T>Copy code only</T>
            </Button>
          </div>
          {canRenderQrForSelection ? (
            <div className="w-fit shrink-0 self-center rounded-xl bg-white p-3 sm:self-start">
              <QRCodeSvg
                value={qrPairingUrl}
                size={168}
                level="M"
                marginSize={1}
                title={gt("Pairing link. Scan to open on another device")}
              />
            </div>
          ) : (
            <div className="flex size-[192px] shrink-0 items-center justify-center self-center rounded-xl border border-border p-4 sm:self-start">
              <p className="text-center text-caption text-dim-foreground">
                <T>
                  No QR for this endpoint. Another device scanning a loopback link would dial
                  itself; copy the URL for use on this machine instead.
                </T>
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
  const gt = useGT();
  const m = useMessages();
  const nowMs = useNowSecond();
  const isLive = clientSession.current || clientSession.connected;
  const lastConnectedAt = clientSession.lastConnectedAt;
  const statusTooltip = isLive
    ? lastConnectedAt
      ? gt("Connected for {duration}", {
          duration: formatElapsedDurationLabel(lastConnectedAt, nowMs, m),
        })
      : gt("Connected")
    : lastConnectedAt
      ? gt("Last connected at {time}", { time: formatAccessTimestamp(lastConnectedAt) })
      : gt("Not connected yet.");
  const lastSeenElapsed = lastConnectedAt
    ? formatElapsedDurationLabel(lastConnectedAt, nowMs, m)
    : null;
  const lastSeen = isLive
    ? gt("Active now")
    : lastSeenElapsed !== null
      ? lastSeenElapsed === m(msg("just now"))
        ? gt("Last seen just now")
        : gt("Last seen {duration} ago", { duration: lastSeenElapsed })
      : null;
  const deviceInfoBits = [
    lastSeen,
    clientSession.client.deviceType !== "unknown"
      ? clientSession.client.deviceType[0]?.toUpperCase() + clientSession.client.deviceType.slice(1)
      : null,
    clientSession.client.os ?? null,
    clientSession.client.browser ?? null,
    clientSession.client.ipAddress ?? null,
  ].filter((value): value is string => value !== null);
  const DeviceIcon =
    clientSession.client.deviceType === "mobile"
      ? SmartphoneIcon
      : clientSession.client.deviceType === "tablet"
        ? TabletIcon
        : MonitorIcon;
  const primaryLabel =
    clientSession.client.label ??
    clientSession.client.browser ??
    clientSession.client.os ??
    clientSession.subject;

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <SettingsRowTile>
            <DeviceIcon />
          </SettingsRowTile>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-h-5 items-center gap-1.5">
              <StatusDot
                size="md"
                tone={isLive ? "success" : "neutral"}
                ping={isLive}
                label={statusTooltip}
              />
              <h3 className="text-label text-strong-foreground">{primaryLabel}</h3>
              {clientSession.current ? (
                <span className="text-micro text-dim-foreground rounded-md border border-border bg-muted/50 px-1 py-0.5">
                  <T>This device</T>
                </span>
              ) : null}
            </div>
            <div className="grid justify-items-start gap-1 text-meta text-muted-foreground">
              <Tooltip>
                <TooltipTrigger render={<span tabIndex={0} />}>
                  {lastSeen ?? gt("Not connected yet")}
                </TooltipTrigger>
                <TooltipPopup side="top">
                  <span className="grid gap-1">
                    {deviceInfoBits
                      .filter((detail) => detail !== lastSeen)
                      .map((detail) => (
                        <span key={detail}>{detail}</span>
                      ))}
                  </span>
                </TooltipPopup>
              </Tooltip>
              <AccessScopeSummary scopes={clientSession.scopes} label={gt("Client scopes")} />
            </div>
          </div>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {!clientSession.current ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={!canRevoke || revokingClientSessionId === clientSession.sessionId}
              onClick={() => void onRevokeSession(clientSession.sessionId)}
            >
              {revokingClientSessionId === clientSession.sessionId ? gt("Revoking…") : gt("Revoke")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

type AuthorizedClientsHeaderActionProps = {
  environmentId: EnvironmentId;
  /** Pairing's header creates links; Authorized clients' header revokes the other sessions. */
  part: "create" | "revoke";
  onPairingLinkCreated: (result: AuthPairingCredentialResult) => void;
  clientSessions: ReadonlyArray<ServerClientSessionRecord> | null;
  isRevokingOtherClients: boolean;
  onRevokeOtherClients: () => void;
  delegatableScopes: ReadonlyArray<AuthEnvironmentScope>;
};

export const AuthorizedClientsHeaderAction = memo(function AuthorizedClientsHeaderAction({
  environmentId,
  part,
  onPairingLinkCreated,
  clientSessions,
  isRevokingOtherClients,
  onRevokeOtherClients,
  delegatableScopes,
}: AuthorizedClientsHeaderActionProps) {
  const gt = useGT();
  const m = useMessages();
  const pairingDenial = managedCapabilityDenial(
    useManagedPolicy(environmentId),
    "remoteClients",
    m,
  );
  const createPairingCredential = useAtomCommand(authEnvironment.createPairingCredential, {
    reportFailure: false,
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pairingLabel, setPairingLabel] = useState("");
  const [pairingScopes, setPairingScopes] = useState<ReadonlyArray<AuthGrantScope>>([
    ...AuthStandardClientScopes,
  ]);
  const selectedScopes = pairingScopes.filter((scope) => delegatableScopes.includes(scope));
  const terminalSelected = selectedScopes.includes(AuthTerminalOperateScope);
  const relayAdminSelected = selectedScopes.includes(AuthRelayConfigureScope);
  const [isCreatingPairingLink, setIsCreatingPairingLink] = useState(false);

  const handleCreatePairingLink = async () => {
    if (
      selectedScopes.length === 0 ||
      !readEnvironmentScope(environmentId, AuthAccessWriteScope) ||
      !selectedScopes.every((scope) => readEnvironmentScope(environmentId, scope))
    )
      return;
    setIsCreatingPairingLink(true);
    const trimmedLabel = pairingLabel.trim();
    const result = await createPairingCredential({
      environmentId,
      input: { ...(trimmedLabel ? { label: trimmedLabel } : {}), scopes: selectedScopes },
    });
    if (result._tag === "Success") {
      onPairingLinkCreated(result.value);
      setPairingLabel("");
      setPairingScopes(
        AuthStandardClientScopes.filter((scope) => delegatableScopes.includes(scope)),
      );
      setDialogOpen(false);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      const message =
        error instanceof Error
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("Failed to create pairing URL.");
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not create pairing URL"),
          description: message,
        }),
      );
    }
    setIsCreatingPairingLink(false);
  };

  const togglePairingScope = (scope: AuthGrantScope, checked: boolean) => {
    setPairingScopes((current) => togglePairingScopeSelection(current, scope, checked));
  };

  if (part === "revoke") {
    return (
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={isRevokingOtherClients || !canRevokeOtherClients(clientSessions)}
        onClick={() => void onRevokeOtherClients()}
      >
        {isRevokingOtherClients ? gt("Revoking…") : gt("Revoke others")}
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button size="xs" variant="secondary" onClick={() => openUseInAnotherApp(environmentId)}>
        <PlugIcon className="size-3" />
        <T>Use in another app (MCP)</T>
      </Button>
      {pairingDenial !== undefined ? (
        <ManagedControl reason={pairingDenial}>
          <Button size="xs" variant="default" disabled>
            <QrCodeIcon />
            <T>Create pairing link</T>
          </Button>
        </ManagedControl>
      ) : null}
      <Dialog
        open={dialogOpen && pairingDenial === undefined}
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
        {pairingDenial === undefined ? (
          <DialogTrigger
            render={
              <Button size="xs" variant="default">
                <QrCodeIcon />
                <T>Create pairing link</T>
              </Button>
            }
          />
        ) : null}
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              <T>Create pairing link</T>
            </DialogTitle>
            <DialogDescription>
              <T>
                Generate a one-time link that another device can use to pair with this backend as an
                authorized client.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block">
              <span className="mb-1.5 block text-meta text-strong-foreground">
                <T>Client label (optional)</T>
              </span>
              <Input
                value={pairingLabel}
                onChange={(event) => setPairingLabel(event.target.value)}
                placeholder={gt("e.g. Living room iPad")}
                disabled={isCreatingPairingLink}
                autoFocus
              />
            </label>
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-meta text-strong-foreground">
                    <T>Permissions</T>
                  </h3>
                  <p className="text-meta text-muted-foreground">
                    <T>Limit what the paired client can do.</T>
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="secondary"
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
                    <T>Read only</T>
                  </Button>
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={isCreatingPairingLink}
                    onClick={() =>
                      setPairingScopes(
                        AuthStandardClientScopes.filter((scope) =>
                          delegatableScopes.includes(scope),
                        ),
                      )
                    }
                  >
                    {gt("Standard", { $context: "standard permission preset" })}
                  </Button>
                </div>
              </div>
              <div className="divide-y divide-border rounded-control surface-well">
                {PAIRING_SCOPE_OPTIONS.filter(({ scope }) => delegatableScopes.includes(scope)).map(
                  ({ scope, title, description }) => (
                    <label
                      key={scope}
                      className="flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:surface-ghost-hover"
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={pairingScopes.includes(scope)}
                        disabled={isCreatingPairingLink}
                        onCheckedChange={(checked) => togglePairingScope(scope, checked === true)}
                      />
                      <span className="min-w-0">
                        <span className="block text-meta text-strong-foreground">{m(title)}</span>
                        <span className="block text-meta leading-snug text-muted-foreground">
                          {m(description)}
                        </span>
                        {terminalSelected && scope === AuthTerminalOperateScope ? (
                          <span className="block text-xs text-warning">
                            {gt(
                              "Terminal commands can read or change files within the server account’s permissions.",
                            )}
                          </span>
                        ) : null}
                        {relayAdminSelected && scope === AuthRelayConfigureScope ? (
                          <span className="block text-xs text-warning">
                            {gt("This client can change who can issue pairing credentials.")}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  ),
                )}
              </div>
              {selectedScopes.length === 0 ? (
                <p className="text-meta text-destructive">
                  <T>Select at least one permission.</T>
                </p>
              ) : selectedScopes.includes(AuthAccessWriteScope) ? (
                <p className="text-meta text-warning-foreground">
                  <T>This client can create or revoke access for other devices.</T>
                </p>
              ) : null}
            </section>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              variant="secondary"
              disabled={isCreatingPairingLink}
              onClick={() => setDialogOpen(false)}
            >
              <T>Cancel</T>
            </Button>
            <Button
              disabled={isCreatingPairingLink || selectedScopes.length === 0}
              onClick={() => void handleCreatePairingLink()}
            >
              {isCreatingPairingLink ? gt("Creating…") : gt("Create link")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});

type PairingClientsListProps = {
  servedByEnvironment: boolean;
  /** Pairing shows the open links; Authorized clients shows the sessions. */
  kind: "links" | "clients";
  endpointUrl: string | null | undefined;
  endpoints: ReadonlyArray<AdvertisedEndpoint>;
  defaultEndpointKey: string | null;
  isLoading: boolean;
  pairingLinks: ReadonlyArray<ServerPairingLinkRecord>;
  createdPairingCredentials: ReadonlyMap<string, string>;
  sharedPairingLinkId: string | null;
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  revokingPairingLinkId: string | null;
  revokingClientSessionId: string | null;
  onRevokePairingLink: (id: string) => void;
  onRevokeClientSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
  canRevoke: boolean;
};

export const PairingClientsList = memo(function PairingClientsList({
  servedByEnvironment,
  kind,
  endpointUrl,
  endpoints,
  defaultEndpointKey,
  isLoading,
  pairingLinks,
  createdPairingCredentials,
  sharedPairingLinkId,
  clientSessions,
  revokingPairingLinkId,
  revokingClientSessionId,
  onRevokePairingLink,
  onRevokeClientSession,
  canRevoke,
}: PairingClientsListProps) {
  const gt = useGT();
  return (
    <>
      {kind === "links" &&
        pairingLinks.map((pairingLink) => (
          <PairingLinkListRow
            key={pairingLink.id}
            pairingLink={pairingLink}
            credential={createdPairingCredentials.get(pairingLink.id)}
            defaultShareOpen={pairingLink.id === sharedPairingLinkId}
            servedByEnvironment={servedByEnvironment}
            endpointUrl={endpointUrl}
            endpoints={endpoints}
            defaultEndpointKey={defaultEndpointKey}
            revokingPairingLinkId={revokingPairingLinkId}
            onRevoke={onRevokePairingLink}
            canRevoke={canRevoke}
          />
        ))}

      {kind === "clients" &&
        clientSessions.map((clientSession) => (
          <ConnectedClientListRow
            key={clientSession.sessionId}
            clientSession={clientSession}
            revokingClientSessionId={revokingClientSessionId}
            onRevokeSession={onRevokeClientSession}
            canRevoke={canRevoke}
          />
        ))}

      {(kind === "links" ? pairingLinks.length === 0 : clientSessions.length === 0) &&
      !isLoading ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-meta text-muted-foreground/60">
            {kind === "links"
              ? gt("No open pairing links. Create one to pair another device.")
              : gt("No client sessions.")}
          </p>
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
  const gt = useGT();
  const isAvailable = endpoint.status === "available";
  const needsTailscaleSetup = isTailscaleHttpsEndpoint(endpoint) && endpoint.status !== "available";
  const canDisableTailscaleServe =
    isTailscaleHttpsEndpoint(endpoint) && endpoint.status === "available";
  const shouldShowEndpointUrl = !needsTailscaleSetup;
  const m = useMessages();
  const remoteDenial = managedCapabilityDenial(usePrimaryManagedPolicy(), "remoteClients", m);
  return (
    <div className={endpointRowClassName(isAvailable)}>
      {isDefault ? (
        <span className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-primary" aria-hidden />
      ) : null}
      <div className="flex min-h-7 min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-h-7 min-w-0 flex-1 items-center gap-3">
          <h3 className="shrink-0 text-label leading-5 text-strong-foreground">{endpoint.label}</h3>
          {shouldShowEndpointUrl ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <p className="min-w-0 truncate text-meta leading-5 text-muted-foreground">
                    {endpoint.httpBaseUrl}
                  </p>
                }
              />
              <TooltipPopup side="top">{endpoint.httpBaseUrl}</TooltipPopup>
            </Tooltip>
          ) : null}
          {!isAvailable ? (
            <span className="inline-flex h-6 shrink-0 items-center rounded-md border border-border px-1.5 text-micro text-muted-foreground">
              <T>Setup required</T>
            </span>
          ) : null}
        </div>
        <div className="ml-auto flex min-h-7 shrink-0 items-center justify-end gap-2">
          {isDefault ? (
            <span className="inline-flex h-6 items-center rounded-md border border-primary/30 bg-primary/10 px-1.5 text-micro text-primary">
              {gt("Default", { $context: "default endpoint badge" })}
            </span>
          ) : null}
          {needsTailscaleSetup ? (
            <ManagedControl reason={remoteDenial}>
              <Button
                size="xs"
                variant="secondary"
                onClick={() => onSetupTailscaleServe(endpoint)}
                disabled={isUpdatingTailscaleServe || remoteDenial !== undefined}
              >
                {isUpdatingTailscaleServe ? gt("Restarting…") : gt("Setup", { $context: "verb" })}
              </Button>
            </ManagedControl>
          ) : null}
          {canDisableTailscaleServe ? (
            <Button
              size="xs"
              variant="destructive-outline"
              onClick={() => onDisableTailscaleServe(endpoint)}
              disabled={isUpdatingTailscaleServe}
            >
              {isUpdatingTailscaleServe ? gt("Restarting…") : gt("Disable")}
            </Button>
          ) : null}
          {!needsTailscaleSetup && !isDefault ? (
            <Button size="xs" variant="secondary" onClick={() => onSetDefault(endpoint)}>
              <T>Set as default</T>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

/** "Reachable at": the default address other devices use, in a mono well with copy. */
export function ReachableAddressRow({
  url,
  hiddenEndpointCount,
  expanded,
  onToggleExpanded,
}: {
  url: string;
  hiddenEndpointCount: number;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const gt = useGT();
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () =>
      toastManager.add({ type: "success", title: resolveMessage(msg("Address copied")) }),
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not copy address"),
          description: error.message,
        }),
      ),
  });
  return (
    <SettingsRow
      title={gt("Reachable at")}
      description={
        hiddenEndpointCount > 0 ? (
          <span className="inline-flex items-baseline gap-1">
            <T>The address other devices use.</T>
            <button
              type="button"
              className="border-b border-dotted border-muted-foreground/60 text-muted-foreground hover:border-foreground hover:text-foreground"
              onClick={onToggleExpanded}
              aria-expanded={expanded}
            >
              {expanded
                ? gt("Hide addresses")
                : gt("+{count} more", { count: hiddenEndpointCount })}
            </button>
          </span>
        ) : (
          gt("The address other devices use.")
        )
      }
      control={
        <span className="flex h-7 min-w-0 max-w-72 items-center gap-1 rounded-control surface-well pr-0.5 pl-2.5">
          <span className="min-w-0 truncate font-mono text-meta text-foreground">{url}</span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("Copy address")}
            onClick={() => copyToClipboard(url)}
          >
            {isCopied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </span>
      }
    />
  );
}
