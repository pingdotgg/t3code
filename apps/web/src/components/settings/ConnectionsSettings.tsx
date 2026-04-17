import { ChevronDownIcon, PlusIcon, QrCodeIcon, RefreshCwIcon } from "lucide-react";
import { type ReactNode, memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  type AuthClientSession,
  type AuthPairingLink,
  type AdvertisedEndpoint,
  type DesktopDiscoveredSshHost,
  type DesktopSshEnvironmentTarget,
  type DesktopServerExposureState,
  type EnvironmentId,
} from "@t3tools/contracts";
import { DateTime } from "effect";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { formatElapsedDurationLabel, formatExpiresInLabel } from "../../timestampFormat";
import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { Input } from "../ui/input";
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
import { ScrollArea } from "../ui/scroll-area";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { setPairingTokenOnUrl } from "../../pairingUrl";
import {
  createServerPairingCredential,
  fetchSessionState,
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  isLoopbackHostname,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
} from "~/environments/primary";
import type { WsRpcClient } from "~/rpc/wsRpcClient";
import {
  type SavedEnvironmentRecord,
  type SavedEnvironmentRuntimeState,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
  addSavedEnvironment,
  connectDesktopSshEnvironment,
  getPrimaryEnvironmentConnection,
  reconnectSavedEnvironment,
  removeSavedEnvironment,
} from "~/environments/runtime";
import { useUiStateStore } from "~/uiStateStore";

const accessTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatAccessTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return accessTimestampFormatter.format(parsed);
}

type ConnectionStatusDotProps = {
  tooltipText?: string | null;
  dotClassName: string;
  pingClassName?: string | null;
};

function ConnectionStatusDot({
  tooltipText,
  dotClassName,
  pingClassName,
}: ConnectionStatusDotProps) {
  const dotContent = (
    <>
      {pingClassName ? (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full",
            pingClassName,
          )}
        />
      ) : null}
      <span className={cn("relative inline-flex size-2 rounded-full", dotClassName)} />
    </>
  );

  if (!tooltipText) {
    return (
      <span className="relative flex size-3 shrink-0 items-center justify-center">
        {dotContent}
      </span>
    );
  }

  const dot = (
    <button
      type="button"
      title={tooltipText}
      aria-label={tooltipText}
      className="relative flex size-3 shrink-0 cursor-help items-center justify-center rounded-full outline-hidden"
    >
      {dotContent}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={dot} />
      <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap leading-tight">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
}

function getSavedBackendStatusTooltip(
  runtime: SavedEnvironmentRuntimeState | null,
  record: SavedEnvironmentRecord,
  nowMs: number,
) {
  const connectionState = runtime?.connectionState ?? "disconnected";

  if (connectionState === "connected") {
    const connectedAt = runtime?.connectedAt ?? record.lastConnectedAt;
    return connectedAt ? `Connected for ${formatElapsedDurationLabel(connectedAt, nowMs)}` : null;
  }

  if (connectionState === "connecting") {
    return null;
  }

  if (connectionState === "error") {
    return runtime?.lastError ?? "An unknown connection error occurred.";
  }

  return record.lastConnectedAt
    ? `Last connected at ${formatAccessTimestamp(record.lastConnectedAt)}`
    : "Not connected yet.";
}

function formatDesktopSshTarget(target: NonNullable<SavedEnvironmentRecord["desktopSsh"]>): string {
  const authority = target.username ? `${target.username}@${target.hostname}` : target.hostname;
  return target.port ? `${authority}:${target.port}` : authority;
}

function parseManualDesktopSshTarget(input: {
  readonly host: string;
  readonly username: string;
  readonly port: string;
}): DesktopSshEnvironmentTarget {
  const rawHost = input.host.trim();
  if (rawHost.length === 0) {
    throw new Error("SSH host or alias is required.");
  }

  let hostname = rawHost;
  let username = input.username.trim() || null;
  let port: number | null = null;

  const atIndex = hostname.lastIndexOf("@");
  if (atIndex > 0) {
    const inlineUsername = hostname.slice(0, atIndex).trim();
    hostname = hostname.slice(atIndex + 1).trim();
    if (!username && inlineUsername.length > 0) {
      username = inlineUsername;
    }
  }

  const bracketedHostMatch = /^\[([^\]]+)\](?::(\d+))?$/u.exec(hostname);
  if (bracketedHostMatch) {
    hostname = bracketedHostMatch[1]!.trim();
    if (bracketedHostMatch[2]) {
      port = Number.parseInt(bracketedHostMatch[2], 10);
    }
  } else {
    const colonSegments = hostname.split(":");
    if (colonSegments.length === 2 && /^\d+$/u.test(colonSegments[1] ?? "")) {
      hostname = colonSegments[0]!.trim();
      port = Number.parseInt(colonSegments[1]!, 10);
    }
  }

  const rawPort = input.port.trim();
  if (rawPort.length > 0) {
    port = Number.parseInt(rawPort, 10);
  }

  if (hostname.length === 0) {
    throw new Error("SSH host or alias is required.");
  }

  if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
    throw new Error("SSH port must be between 1 and 65535.");
  }

  return {
    alias: hostname,
    hostname,
    username,
    port,
  };
}

/** Direct row in the card – same pattern as the Provider / ACP-agent list rows. */
const ITEM_ROW_CLASSNAME = "border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5";
const ENDPOINT_ROW_CLASSNAME = "border-t border-border/60 px-4 py-2.5 first:border-t-0 sm:px-5";

const ITEM_ROW_INNER_CLASSNAME =
  "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between";

function sortDesktopPairingLinks(links: ReadonlyArray<ServerPairingLinkRecord>) {
  return [...links].toSorted(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

function sortDesktopClientSessions(sessions: ReadonlyArray<ServerClientSessionRecord>) {
  return [...sessions].toSorted((left, right) => {
    if (left.current !== right.current) {
      return left.current ? -1 : 1;
    }
    if (left.connected !== right.connected) {
      return left.connected ? -1 : 1;
    }
    return new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime();
  });
}

function toDesktopPairingLinkRecord(pairingLink: AuthPairingLink): ServerPairingLinkRecord {
  return {
    ...pairingLink,
    createdAt: DateTime.formatIso(pairingLink.createdAt),
    expiresAt: DateTime.formatIso(pairingLink.expiresAt),
  };
}

function toDesktopClientSessionRecord(clientSession: AuthClientSession): ServerClientSessionRecord {
  return {
    ...clientSession,
    issuedAt: DateTime.formatIso(clientSession.issuedAt),
    expiresAt: DateTime.formatIso(clientSession.expiresAt),
    lastConnectedAt:
      clientSession.lastConnectedAt === null
        ? null
        : DateTime.formatIso(clientSession.lastConnectedAt),
  };
}

function upsertDesktopPairingLink(
  current: ReadonlyArray<ServerPairingLinkRecord>,
  next: ServerPairingLinkRecord,
) {
  const existingIndex = current.findIndex((pairingLink) => pairingLink.id === next.id);
  if (existingIndex === -1) {
    return sortDesktopPairingLinks([...current, next]);
  }
  const updated = [...current];
  updated[existingIndex] = next;
  return sortDesktopPairingLinks(updated);
}

function removeDesktopPairingLink(current: ReadonlyArray<ServerPairingLinkRecord>, id: string) {
  return current.filter((pairingLink) => pairingLink.id !== id);
}

function upsertDesktopClientSession(
  current: ReadonlyArray<ServerClientSessionRecord>,
  next: ServerClientSessionRecord,
) {
  const existingIndex = current.findIndex(
    (clientSession) => clientSession.sessionId === next.sessionId,
  );
  if (existingIndex === -1) {
    return sortDesktopClientSessions([...current, next]);
  }
  const updated = [...current];
  updated[existingIndex] = next;
  return sortDesktopClientSessions(updated);
}

function removeDesktopClientSession(
  current: ReadonlyArray<ServerClientSessionRecord>,
  sessionId: ServerClientSessionRecord["sessionId"],
) {
  return current.filter((clientSession) => clientSession.sessionId !== sessionId);
}

function selectPairingEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  defaultEndpointKey?: string | null,
): AdvertisedEndpoint | null {
  const availableEndpoints = endpoints.filter((endpoint) => endpoint.status !== "unavailable");
  if (defaultEndpointKey) {
    const selectedEndpoint = availableEndpoints.find(
      (endpoint) => endpointDefaultPreferenceKey(endpoint) === defaultEndpointKey,
    );
    if (selectedEndpoint) {
      return selectedEndpoint;
    }
  }
  return (
    availableEndpoints.find((endpoint) => endpoint.compatibility.hostedHttpsApp === "compatible") ??
    availableEndpoints.find((endpoint) => endpoint.isDefault) ??
    availableEndpoints.find((endpoint) => endpoint.reachability !== "loopback") ??
    null
  );
}

function endpointDefaultPreferenceKey(endpoint: AdvertisedEndpoint): string {
  if (endpoint.id.startsWith("desktop-loopback:")) {
    return "desktop-core:loopback:http";
  }
  if (endpoint.id.startsWith("desktop-lan:")) {
    return "desktop-core:lan:http";
  }
  if (endpoint.id.startsWith("tailscale-ip:")) {
    return "tailscale:ip:http";
  }
  if (endpoint.id.startsWith("tailscale-magicdns:")) {
    return "tailscale:magicdns:https";
  }

  let scheme = "unknown";
  try {
    scheme = new URL(endpoint.httpBaseUrl).protocol.replace(/:$/u, "");
  } catch {
    // Keep the stored preference stable even if a custom endpoint is malformed.
  }

  return `${endpoint.provider.id}:${endpoint.reachability}:${scheme}:${endpoint.label}`;
}

function resolveAdvertisedEndpointPairingUrl(
  endpoint: AdvertisedEndpoint,
  credential: string,
): string {
  if (endpoint.compatibility.hostedHttpsApp === "compatible") {
    return (
      resolveHostedPairingUrl(endpoint.httpBaseUrl, credential) ??
      resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential)
    );
  }
  return resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential);
}

function resolveCurrentOriginPairingUrl(credential: string): string {
  const url = new URL("/pair", window.location.href);
  return setPairingTokenOnUrl(url, credential).toString();
}

type PairingLinkListRowProps = {
  pairingLink: ServerPairingLinkRecord;
  endpointUrl: string | null | undefined;
  endpoints: ReadonlyArray<AdvertisedEndpoint>;
  defaultEndpointKey: string | null;
  revokingPairingLinkId: string | null;
  onRevoke: (id: string) => void;
};

const PairingLinkListRow = memo(function PairingLinkListRow({
  pairingLink,
  endpointUrl,
  endpoints,
  defaultEndpointKey,
  revokingPairingLinkId,
  onRevoke,
}: PairingLinkListRowProps) {
  const nowMs = useRelativeTimeTick(1_000);
  const expiresAtMs = useMemo(
    () => new Date(pairingLink.expiresAt).getTime(),
    [pairingLink.expiresAt],
  );
  const [isRevealDialogOpen, setIsRevealDialogOpen] = useState(false);

  const currentOriginPairingUrl = useMemo(
    () => resolveCurrentOriginPairingUrl(pairingLink.credential),
    [pairingLink.credential],
  );
  const hostedPairingUrl = useMemo(
    () =>
      endpointUrl != null && endpointUrl !== ""
        ? resolveHostedPairingUrl(endpointUrl, pairingLink.credential)
        : null,
    [endpointUrl, pairingLink.credential],
  );
  const endpointPairingUrl = useMemo(() => {
    const endpoint = selectPairingEndpoint(endpoints, defaultEndpointKey);
    return endpoint ? resolveAdvertisedEndpointPairingUrl(endpoint, pairingLink.credential) : null;
  }, [defaultEndpointKey, endpoints, pairingLink.credential]);
  const endpointCopyOptions = useMemo(
    () =>
      endpoints
        .filter((endpoint) => endpoint.status !== "unavailable")
        .map((endpoint) => ({
          key: endpointDefaultPreferenceKey(endpoint),
          label: endpoint.label,
          url: resolveAdvertisedEndpointPairingUrl(endpoint, pairingLink.credential),
        })),
    [endpoints, pairingLink.credential],
  );
  const shareablePairingUrl =
    endpointPairingUrl ??
    (endpointUrl != null && endpointUrl !== ""
      ? (hostedPairingUrl ?? resolveDesktopPairingUrl(endpointUrl, pairingLink.credential))
      : isLoopbackHostname(window.location.hostname)
        ? null
        : currentOriginPairingUrl);
  const revealValue = shareablePairingUrl ?? pairingLink.credential;
  const canCopyToClipboard =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    navigator.clipboard?.writeText != null;

  const { copyToClipboard } = useCopyToClipboard<"code" | "link">({
    onCopy: (kind) => {
      toastManager.add({
        type: "success",
        title: kind === "link" ? "Pairing URL copied" : "Pairing code copied",
        description:
          kind === "link"
            ? "Open it in the client you want to pair to this environment."
            : "Paste it into another client to finish pairing.",
      });
    },
    onError: (error, kind) => {
      setIsRevealDialogOpen(true);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: canCopyToClipboard
            ? kind === "link"
              ? "Could not copy pairing URL"
              : "Could not copy pairing code"
            : "Clipboard copy unavailable",
          description: canCopyToClipboard ? error.message : "Showing the full value instead.",
        }),
      );
    },
  });

  const copyPairingValue = useCallback(
    (value: string, kind: "code" | "link") => {
      copyToClipboard(value, kind);
    },
    [copyToClipboard],
  );

  const handleCopyCode = useCallback(() => {
    copyPairingValue(pairingLink.credential, "code");
  }, [copyPairingValue, pairingLink.credential]);

  const handleCopyDefaultLink = useCallback(() => {
    if (!shareablePairingUrl) return;
    copyPairingValue(shareablePairingUrl, "link");
  }, [copyPairingValue, shareablePairingUrl]);

  const expiresAbsolute = formatAccessTimestamp(pairingLink.expiresAt);

  const roleLabel = pairingLink.role === "owner" ? "Owner" : "Client";
  const primaryLabel = pairingLink.label ?? `${roleLabel} link`;

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
              dotClassName="bg-amber-400"
            />
            <h3 className="text-sm font-medium text-foreground">{primaryLabel}</h3>
            <Popover>
              {shareablePairingUrl ? (
                <>
                  <PopoverTrigger
                    openOnHover
                    delay={250}
                    closeDelay={100}
                    render={
                      <button
                        type="button"
                        className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/50 outline-none hover:text-foreground"
                        aria-label="Show QR code"
                      />
                    }
                  >
                    <QrCodeIcon aria-hidden className="size-3" />
                  </PopoverTrigger>
                  <PopoverPopup side="top" align="start" tooltipStyle className="w-max">
                    <QRCodeSvg
                      value={shareablePairingUrl}
                      size={88}
                      level="M"
                      marginSize={2}
                      title="Pairing link — scan to open on another device"
                    />
                  </PopoverPopup>
                </>
              ) : null}
            </Popover>
          </div>
          <p className="text-xs text-muted-foreground" title={expiresAbsolute}>
            {[roleLabel, formatExpiresInLabel(pairingLink.expiresAt, nowMs)].join(" · ")}
          </p>
          {shareablePairingUrl === null ? (
            <p className="text-[11px] text-muted-foreground/70">
              Copy the token and pair from another client using this backend&apos;s reachable host.
            </p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Dialog open={isRevealDialogOpen} onOpenChange={setIsRevealDialogOpen}>
            {canCopyToClipboard ? (
              <>
                <Button size="xs" variant="outline" onClick={handleCopyCode}>
                  Copy code
                </Button>
                {shareablePairingUrl ? (
                  endpointCopyOptions.length > 1 ? (
                    <Group aria-label="Copy pairing URL">
                      <Button size="xs" variant="outline" onClick={handleCopyDefaultLink}>
                        Copy pairing URL
                      </Button>
                      <GroupSeparator />
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              size="icon-xs"
                              variant="outline"
                              aria-label="Pairing URL copy options"
                            />
                          }
                        >
                          <ChevronDownIcon className="size-3.5" />
                        </MenuTrigger>
                        <MenuPopup align="end" className="min-w-52">
                          {endpointCopyOptions.map((option) => (
                            <MenuItem
                              key={option.key}
                              onClick={() => copyPairingValue(option.url, "link")}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate">{option.label}</span>
                                <span className="block truncate text-[11px] text-muted-foreground">
                                  Pairing URL
                                </span>
                              </span>
                            </MenuItem>
                          ))}
                        </MenuPopup>
                      </Menu>
                    </Group>
                  ) : (
                    <Button size="xs" variant="outline" onClick={handleCopyDefaultLink}>
                      Copy pairing URL
                    </Button>
                  )
                ) : null}
              </>
            ) : (
              <DialogTrigger render={<Button size="xs" variant="outline" />}>
                {shareablePairingUrl ? "Show link" : "Show code"}
              </DialogTrigger>
            )}
            <DialogPopup className="max-w-md">
              <DialogHeader>
                <DialogTitle>{shareablePairingUrl ? "Pairing link" : "Pairing code"}</DialogTitle>
                <DialogDescription>
                  {shareablePairingUrl
                    ? "Clipboard copy is unavailable here. Open or manually copy this full pairing URL on the device you want to connect."
                    : "Clipboard copy is unavailable here. Manually copy this code into another client."}
                </DialogDescription>
              </DialogHeader>
              <DialogPanel className="space-y-4">
                <Textarea
                  readOnly
                  value={revealValue}
                  rows={shareablePairingUrl ? 4 : 3}
                  className="text-xs leading-relaxed"
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.currentTarget.select()}
                />
                {shareablePairingUrl ? (
                  <div className="flex justify-center rounded-xl border border-border/60 bg-muted/30 p-4">
                    <QRCodeSvg
                      value={shareablePairingUrl}
                      size={132}
                      level="M"
                      marginSize={2}
                      title="Pairing link — scan to open on another device"
                    />
                  </div>
                ) : null}
              </DialogPanel>
              <DialogFooter variant="bare">
                <Button variant="outline" onClick={() => setIsRevealDialogOpen(false)}>
                  Done
                </Button>
                {canCopyToClipboard ? (
                  <Button variant="outline" size="xs" onClick={handleCopyCode}>
                    Copy code
                  </Button>
                ) : null}
              </DialogFooter>
            </DialogPopup>
          </Dialog>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={revokingPairingLinkId === pairingLink.id}
            onClick={() => void onRevoke(pairingLink.id)}
          >
            {revokingPairingLinkId === pairingLink.id ? "Revoking…" : "Revoke"}
          </Button>
        </div>
      </div>
    </div>
  );
});

type ConnectedClientListRowProps = {
  clientSession: ServerClientSessionRecord;
  revokingClientSessionId: string | null;
  onRevokeSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
};

const ConnectedClientListRow = memo(function ConnectedClientListRow({
  clientSession,
  revokingClientSessionId,
  onRevokeSession,
}: ConnectedClientListRowProps) {
  const nowMs = useRelativeTimeTick(1_000);
  const isLive = clientSession.current || clientSession.connected;
  const lastConnectedAt = clientSession.lastConnectedAt;
  const statusTooltip = isLive
    ? lastConnectedAt
      ? `Connected for ${formatElapsedDurationLabel(lastConnectedAt, nowMs)}`
      : "Connected"
    : lastConnectedAt
      ? `Last connected at ${formatAccessTimestamp(lastConnectedAt)}`
      : "Not connected yet.";
  const roleLabel = clientSession.role === "owner" ? "Owner" : "Client";
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
              <span className="text-[10px] text-muted-foreground/80 rounded-md border border-border/50 bg-muted/50 px-1 py-0.5">
                This device
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {[roleLabel, ...deviceInfoBits].join(" · ")}
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {!clientSession.current ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={revokingClientSessionId === clientSession.sessionId}
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
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  isRevokingOtherClients: boolean;
  onRevokeOtherClients: () => void;
};

const AuthorizedClientsHeaderAction = memo(function AuthorizedClientsHeaderAction({
  clientSessions,
  isRevokingOtherClients,
  onRevokeOtherClients,
}: AuthorizedClientsHeaderActionProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pairingLabel, setPairingLabel] = useState("");
  const [isCreatingPairingLink, setIsCreatingPairingLink] = useState(false);

  const handleCreatePairingLink = useCallback(async () => {
    setIsCreatingPairingLink(true);
    try {
      await createServerPairingCredential(pairingLabel);
      setPairingLabel("");
      setDialogOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create pairing URL.";
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create pairing URL",
          description: message,
        }),
      );
    } finally {
      setIsCreatingPairingLink(false);
    }
  }, [pairingLabel]);

  return (
    <div className="flex items-center gap-2">
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={
          isRevokingOtherClients || clientSessions.every((clientSession) => clientSession.current)
        }
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
        <DialogPopup className="max-w-sm">
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
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              variant="outline"
              disabled={isCreatingPairingLink}
              onClick={() => setDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button disabled={isCreatingPairingLink} onClick={() => void handleCreatePairingLink()}>
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
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  revokingPairingLinkId: string | null;
  revokingClientSessionId: string | null;
  onRevokePairingLink: (id: string) => void;
  onRevokeClientSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
};

const PairingClientsList = memo(function PairingClientsList({
  endpointUrl,
  endpoints,
  defaultEndpointKey,
  isLoading,
  pairingLinks,
  clientSessions,
  revokingPairingLinkId,
  revokingClientSessionId,
  onRevokePairingLink,
  onRevokeClientSession,
}: PairingClientsListProps) {
  return (
    <>
      {pairingLinks.map((pairingLink) => (
        <PairingLinkListRow
          key={pairingLink.id}
          pairingLink={pairingLink}
          endpointUrl={endpointUrl}
          endpoints={endpoints}
          defaultEndpointKey={defaultEndpointKey}
          revokingPairingLinkId={revokingPairingLinkId}
          onRevoke={onRevokePairingLink}
        />
      ))}

      {clientSessions.map((clientSession) => (
        <ConnectedClientListRow
          key={clientSession.sessionId}
          clientSession={clientSession}
          revokingClientSessionId={revokingClientSessionId}
          onRevokeSession={onRevokeClientSession}
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
};

const AdvertisedEndpointListRow = memo(function AdvertisedEndpointListRow({
  endpoint,
  isDefault,
  onSetDefault,
}: AdvertisedEndpointListRowProps) {
  return (
    <div className={ENDPOINT_ROW_CLASSNAME}>
      <div className="flex min-h-6 min-w-0 flex-col gap-2 sm:-my-0.5 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-baseline gap-3">
          <h3 className="shrink-0 text-sm leading-5 font-medium text-foreground">
            {endpoint.label}
          </h3>
          <p
            className="min-w-0 truncate text-xs leading-5 text-muted-foreground"
            title={endpoint.httpBaseUrl}
          >
            {endpoint.httpBaseUrl}
          </p>
        </div>
        <div className="ml-auto flex min-h-6 shrink-0 items-center justify-end gap-2">
          {isDefault ? (
            <span className="rounded-md border border-primary/30 bg-primary/10 px-1 py-0.5 text-[10px] text-primary">
              Default
            </span>
          ) : null}
          {!isDefault ? (
            <Button size="xs" variant="outline" onClick={() => onSetDefault(endpoint)}>
              Set as default
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

function NetworkAccessDescription({
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

  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="min-w-0 truncate">Reachable at {endpoint.httpBaseUrl}</span>
      {hiddenEndpointCount > 0 ? (
        <button
          type="button"
          className="inline-flex h-5 shrink-0 items-center rounded-md border border-border/60 px-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
        >
          {expanded ? "Hide" : `+${hiddenEndpointCount}`}
        </button>
      ) : null}
    </span>
  );
}

type SavedBackendListRowProps = {
  environmentId: EnvironmentId;
  reconnectingEnvironmentId: EnvironmentId | null;
  removingEnvironmentId: EnvironmentId | null;
  onReconnect: (environmentId: EnvironmentId) => void;
  onRemove: (environmentId: EnvironmentId) => void;
};

function SavedBackendListRow({
  environmentId,
  reconnectingEnvironmentId,
  removingEnvironmentId,
  onReconnect,
  onRemove,
}: SavedBackendListRowProps) {
  const nowMs = useRelativeTimeTick(1_000);
  const record = useSavedEnvironmentRegistryStore((state) => state.byId[environmentId] ?? null);
  const runtime = useSavedEnvironmentRuntimeStore((state) => state.byId[environmentId] ?? null);

  if (!record) {
    return null;
  }

  const connectionState = runtime?.connectionState ?? "disconnected";
  const stateDotClassName =
    connectionState === "connected"
      ? "bg-success"
      : connectionState === "connecting"
        ? "bg-warning"
        : connectionState === "error"
          ? "bg-destructive"
          : "bg-muted-foreground/40";
  const roleLabel = runtime?.role ? (runtime.role === "owner" ? "Owner" : "Client") : null;
  const descriptorLabel = runtime?.descriptor?.label ?? null;
  const statusTooltip = getSavedBackendStatusTooltip(runtime, record, nowMs);
  const metadataBits = [
    record.desktopSsh ? `SSH ${formatDesktopSshTarget(record.desktopSsh)}` : null,
    roleLabel,
    record.lastConnectedAt
      ? `Last connected ${formatAccessTimestamp(record.lastConnectedAt)}`
      : null,
  ].filter((value): value is string => value !== null);

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={statusTooltip}
              dotClassName={stateDotClassName}
              pingClassName={
                connectionState === "connecting" ? "bg-warning/60 duration-2000" : null
              }
            />
            <h3 className="text-sm font-medium text-foreground">{record.label}</h3>
          </div>
          {metadataBits.length > 0 ? (
            <p className="text-xs text-muted-foreground">{metadataBits.join(" · ")}</p>
          ) : null}
          {descriptorLabel && descriptorLabel !== record.label ? (
            <p className="text-xs text-muted-foreground">Server label: {descriptorLabel}</p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Button
            size="xs"
            variant="outline"
            disabled={reconnectingEnvironmentId === environmentId}
            onClick={() => void onReconnect(environmentId)}
          >
            {reconnectingEnvironmentId === environmentId ? "Reconnecting…" : "Reconnect"}
          </Button>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={removingEnvironmentId === environmentId}
            onClick={() => void onRemove(environmentId)}
          >
            {removingEnvironmentId === environmentId ? "Removing…" : "Remove"}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface DesktopSshHostRowProps {
  target: DesktopDiscoveredSshHost;
  savedRecord: SavedEnvironmentRecord | null;
  connectingHostAlias: string | null;
  onConnect: (target: DesktopDiscoveredSshHost) => void;
}

const DesktopSshHostRow = memo(function DesktopSshHostRow({
  target,
  savedRecord,
  connectingHostAlias,
  onConnect,
}: DesktopSshHostRowProps) {
  const address = formatDesktopSshTarget(target);
  const secondaryBits = [target.source === "ssh-config" ? "SSH config" : "Known hosts", address];
  const buttonLabel =
    connectingHostAlias === target.alias ? "Connecting…" : savedRecord ? "Reconnect" : "Connect";

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium text-foreground">{target.alias}</h3>
          </div>
          <p className="text-xs text-muted-foreground">{secondaryBits.join(" · ")}</p>
          {savedRecord ? (
            <p className="text-xs text-muted-foreground">
              Saved as {savedRecord.label}
              {savedRecord.lastConnectedAt
                ? ` · Last connected ${formatAccessTimestamp(savedRecord.lastConnectedAt)}`
                : ""}
            </p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Button
            size="xs"
            variant="outline"
            disabled={connectingHostAlias === target.alias}
            onClick={() => onConnect(target)}
          >
            {connectingHostAlias === target.alias ? (
              <RefreshCwIcon className="size-3 animate-spin" />
            ) : null}
            {buttonLabel}
          </Button>
        </div>
      </div>
    </div>
  );
});

export function ConnectionsSettings() {
  const desktopBridge = window.desktopBridge;
  const [currentSessionRole, setCurrentSessionRole] = useState<"owner" | "client" | null>(
    desktopBridge ? "owner" : null,
  );
  const [currentAuthPolicy, setCurrentAuthPolicy] = useState<
    "desktop-managed-local" | "loopback-browser" | "remote-reachable" | "unsafe-no-auth" | null
  >(desktopBridge ? null : null);
  const savedEnvironmentsById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const savedEnvironmentIds = useMemo(
    () =>
      Object.values(savedEnvironmentsById)
        .toSorted((left, right) => left.label.localeCompare(right.label))
        .map((record) => record.environmentId),
    [savedEnvironmentsById],
  );
  const savedDesktopSshEnvironmentsByAlias = useMemo(
    () =>
      Object.values(savedEnvironmentsById).reduce<Record<string, SavedEnvironmentRecord>>(
        (accumulator, record) => {
          if (record.desktopSsh?.alias) {
            accumulator[record.desktopSsh.alias] = record;
          }
          return accumulator;
        },
        {},
      ),
    [savedEnvironmentsById],
  );
  const [discoveredSshHosts, setDiscoveredSshHosts] = useState<
    ReadonlyArray<DesktopDiscoveredSshHost>
  >([]);
  const [hasLoadedDiscoveredSshHosts, setHasLoadedDiscoveredSshHosts] = useState(false);
  const [isLoadingDiscoveredSshHosts, setIsLoadingDiscoveredSshHosts] = useState(false);
  const [discoveredSshHostsError, setDiscoveredSshHostsError] = useState<string | null>(null);
  const [connectingSshHostAlias, setConnectingSshHostAlias] = useState<string | null>(null);

  const [desktopServerExposureState, setDesktopServerExposureState] =
    useState<DesktopServerExposureState | null>(null);
  const [desktopAdvertisedEndpoints, setDesktopAdvertisedEndpoints] = useState<
    ReadonlyArray<AdvertisedEndpoint>
  >([]);
  const [desktopServerExposureError, setDesktopServerExposureError] = useState<string | null>(null);
  const [desktopPairingLinks, setDesktopPairingLinks] = useState<
    ReadonlyArray<ServerPairingLinkRecord>
  >([]);
  const [desktopClientSessions, setDesktopClientSessions] = useState<
    ReadonlyArray<ServerClientSessionRecord>
  >([]);
  const [desktopAccessManagementError, setDesktopAccessManagementError] = useState<string | null>(
    null,
  );
  const [isLoadingDesktopAccessManagement, setIsLoadingDesktopAccessManagement] = useState(false);
  const [revokingDesktopPairingLinkId, setRevokingDesktopPairingLinkId] = useState<string | null>(
    null,
  );
  const [revokingDesktopClientSessionId, setRevokingDesktopClientSessionId] = useState<
    string | null
  >(null);
  const [isRevokingOtherDesktopClients, setIsRevokingOtherDesktopClients] = useState(false);
  const [addBackendDialogOpen, setAddBackendDialogOpen] = useState(false);
  const [savedBackendMode, setSavedBackendMode] = useState<"pairing-url" | "host-code" | "ssh">(
    "pairing-url",
  );
  const [savedBackendLabel, setSavedBackendLabel] = useState("");
  const [savedBackendPairingUrl, setSavedBackendPairingUrl] = useState("");
  const [savedBackendHost, setSavedBackendHost] = useState("");
  const [savedBackendPairingCode, setSavedBackendPairingCode] = useState("");
  const [savedBackendSshHost, setSavedBackendSshHost] = useState("");
  const [savedBackendSshUsername, setSavedBackendSshUsername] = useState("");
  const [savedBackendSshPort, setSavedBackendSshPort] = useState("");
  const [savedBackendError, setSavedBackendError] = useState<string | null>(null);
  const [isAddingSavedBackend, setIsAddingSavedBackend] = useState(false);
  const [reconnectingSavedEnvironmentId, setReconnectingSavedEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const [removingSavedEnvironmentId, setRemovingSavedEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const [isUpdatingDesktopServerExposure, setIsUpdatingDesktopServerExposure] = useState(false);
  const [pendingDesktopServerExposureMode, setPendingDesktopServerExposureMode] = useState<
    DesktopServerExposureState["mode"] | null
  >(null);
  const [isAdvertisedEndpointListExpanded, setIsAdvertisedEndpointListExpanded] = useState(false);
  const defaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.defaultAdvertisedEndpointKey,
  );
  const setDefaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.setDefaultAdvertisedEndpointKey,
  );
  const canManageLocalBackend = currentSessionRole === "owner";
  const isLocalBackendNetworkAccessible = desktopBridge
    ? desktopServerExposureState?.mode === "network-accessible"
    : currentAuthPolicy === "remote-reachable";

  const handleDesktopServerExposureChange = useCallback(
    async (checked: boolean) => {
      if (!desktopBridge) return;
      setIsUpdatingDesktopServerExposure(true);
      setDesktopServerExposureError(null);
      try {
        const nextState = await desktopBridge.setServerExposureMode(
          checked ? "network-accessible" : "local-only",
        );
        setDesktopServerExposureState(nextState);
        setPendingDesktopServerExposureMode(null);
        setIsUpdatingDesktopServerExposure(false);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to update network exposure.";
        setPendingDesktopServerExposureMode(null);
        setDesktopServerExposureError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not update network access",
            description: message,
          }),
        );
        setIsUpdatingDesktopServerExposure(false);
      }
    },
    [desktopBridge],
  );

  const handleConfirmDesktopServerExposureChange = useCallback(() => {
    if (pendingDesktopServerExposureMode === null) return;
    const checked = pendingDesktopServerExposureMode === "network-accessible";
    void handleDesktopServerExposureChange(checked);
  }, [handleDesktopServerExposureChange, pendingDesktopServerExposureMode]);

  const handleRevokeDesktopPairingLink = useCallback(async (id: string) => {
    setRevokingDesktopPairingLinkId(id);
    setDesktopAccessManagementError(null);
    try {
      await revokeServerPairingLink(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to revoke pairing link.";
      setDesktopAccessManagementError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not revoke pairing link",
          description: message,
        }),
      );
    } finally {
      setRevokingDesktopPairingLinkId(null);
    }
  }, []);

  const handleRevokeDesktopClientSession = useCallback(
    async (sessionId: ServerClientSessionRecord["sessionId"]) => {
      setRevokingDesktopClientSessionId(sessionId);
      setDesktopAccessManagementError(null);
      try {
        await revokeServerClientSession(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to revoke client access.";
        setDesktopAccessManagementError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not revoke client access",
            description: message,
          }),
        );
      } finally {
        setRevokingDesktopClientSessionId(null);
      }
    },
    [],
  );

  const handleRevokeOtherDesktopClients = useCallback(async () => {
    setIsRevokingOtherDesktopClients(true);
    setDesktopAccessManagementError(null);
    try {
      const revokedCount = await revokeOtherServerClientSessions();
      toastManager.add({
        type: "success",
        title: revokedCount === 1 ? "Revoked 1 other client" : `Revoked ${revokedCount} clients`,
        description: "Other paired clients will need a new pairing link before reconnecting.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to revoke other clients.";
      setDesktopAccessManagementError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not revoke other clients",
          description: message,
        }),
      );
    } finally {
      setIsRevokingOtherDesktopClients(false);
    }
  }, []);

  const handleAddSavedBackend = useCallback(async () => {
    if (savedBackendMode === "ssh") {
      setIsAddingSavedBackend(true);
      setSavedBackendError(null);
      try {
        const target = parseManualDesktopSshTarget({
          host: savedBackendSshHost,
          username: savedBackendSshUsername,
          port: savedBackendSshPort,
        });
        const record = await connectDesktopSshEnvironment(target, {
          label: savedBackendLabel,
        });
        setSavedBackendLabel("");
        setSavedBackendPairingUrl("");
        setSavedBackendHost("");
        setSavedBackendPairingCode("");
        setSavedBackendSshHost("");
        setSavedBackendSshUsername("");
        setSavedBackendSshPort("");

        setAddBackendDialogOpen(false);
        toastManager.add({
          type: "success",
          title: "Environment connected",
          description: `${record.label} is ready over an SSH-managed tunnel.`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to connect SSH host.";

        setSavedBackendError(message);
        toastManager.add({
          type: "error",
          title: "Could not connect SSH host",
          description: message,
        });
      } finally {
        setIsAddingSavedBackend(false);
      }
      return;
    }

    setIsAddingSavedBackend(true);
    setSavedBackendError(null);
    try {
      const record = await addSavedEnvironment({
        label: savedBackendLabel,
        ...(savedBackendMode === "pairing-url"
          ? { pairingUrl: savedBackendPairingUrl }
          : {
              host: savedBackendHost,
              pairingCode: savedBackendPairingCode,
            }),
      });
      setSavedBackendLabel("");
      setSavedBackendPairingUrl("");
      setSavedBackendHost("");
      setSavedBackendPairingCode("");
      setSavedBackendSshHost("");
      setSavedBackendSshUsername("");
      setSavedBackendSshPort("");
      setAddBackendDialogOpen(false);
      toastManager.add({
        type: "success",
        title: "Backend added",
        description: `${record.label} is now saved and will reconnect on app startup.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add backend.";
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not add backend",
          description: message,
        }),
      );
    } finally {
      setIsAddingSavedBackend(false);
    }
  }, [
    savedBackendHost,
    savedBackendLabel,
    savedBackendMode,
    savedBackendPairingCode,
    savedBackendPairingUrl,
    savedBackendSshHost,
    savedBackendSshPort,
    savedBackendSshUsername,
  ]);

  const handleReconnectSavedBackend = useCallback(async (environmentId: EnvironmentId) => {
    setReconnectingSavedEnvironmentId(environmentId);
    setSavedBackendError(null);
    try {
      await reconnectSavedEnvironment(environmentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reconnect backend.";
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not reconnect backend",
          description: message,
        }),
      );
    } finally {
      setReconnectingSavedEnvironmentId(null);
    }
  }, []);

  const handleRemoveSavedBackend = useCallback(async (environmentId: EnvironmentId) => {
    setRemovingSavedEnvironmentId(environmentId);
    setSavedBackendError(null);
    try {
      await removeSavedEnvironment(environmentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to remove backend.";
      setSavedBackendError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not remove backend",
          description: message,
        }),
      );
    } finally {
      setRemovingSavedEnvironmentId(null);
    }
  }, []);

  const loadDiscoveredSshHosts = useCallback(async () => {
    if (!desktopBridge) {
      setDiscoveredSshHosts([]);
      setHasLoadedDiscoveredSshHosts(false);
      setDiscoveredSshHostsError(null);
      return;
    }

    setIsLoadingDiscoveredSshHosts(true);
    setDiscoveredSshHostsError(null);
    try {
      const hosts = await desktopBridge.discoverSshHosts();
      setDiscoveredSshHosts(hosts);
      setHasLoadedDiscoveredSshHosts(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to discover SSH hosts.";
      setDiscoveredSshHostsError(message);
      setHasLoadedDiscoveredSshHosts(true);
    } finally {
      setIsLoadingDiscoveredSshHosts(false);
    }
  }, [desktopBridge]);

  const handleConnectSshHost = useCallback(
    async (target: DesktopSshEnvironmentTarget, label?: string) => {
      setConnectingSshHostAlias(target.alias);
      if (savedBackendMode === "ssh") {
        setSavedBackendError(null);
      } else {
        setDiscoveredSshHostsError(null);
      }
      try {
        const record = await connectDesktopSshEnvironment(
          target,
          label === undefined ? undefined : { label },
        );
        setSavedBackendLabel("");
        setSavedBackendSshHost("");
        setSavedBackendSshUsername("");
        setSavedBackendSshPort("");
        setAddBackendDialogOpen(false);
        toastManager.add({
          type: "success",
          title: savedDesktopSshEnvironmentsByAlias[target.alias]
            ? "Environment reconnected"
            : "Environment connected",
          description: `${record.label} is ready over an SSH-managed tunnel.`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to connect SSH host.";
        if (savedBackendMode === "ssh") {
          setSavedBackendError(message);
        } else {
          setDiscoveredSshHostsError(message);
        }
        toastManager.add({
          type: "error",
          title: "Could not connect SSH host",
          description: message,
        });
      } finally {
        setConnectingSshHostAlias(null);
      }
    },
    [savedBackendMode, savedDesktopSshEnvironmentsByAlias],
  );

  useEffect(() => {
    if (!desktopBridge || !addBackendDialogOpen || savedBackendMode !== "ssh") {
      return;
    }
    if (hasLoadedDiscoveredSshHosts || isLoadingDiscoveredSshHosts) {
      return;
    }
    void loadDiscoveredSshHosts();
  }, [
    addBackendDialogOpen,
    desktopBridge,
    hasLoadedDiscoveredSshHosts,
    isLoadingDiscoveredSshHosts,
    loadDiscoveredSshHosts,
    savedBackendMode,
  ]);

  useEffect(() => {
    if (desktopBridge) {
      setCurrentSessionRole("owner");
      return;
    }

    let cancelled = false;
    void fetchSessionState()
      .then((session) => {
        if (cancelled) return;
        setCurrentSessionRole(session.authenticated ? (session.role ?? null) : null);
        setCurrentAuthPolicy(session.auth.policy);
      })
      .catch(() => {
        if (cancelled) return;
        setCurrentSessionRole(null);
        setCurrentAuthPolicy(null);
      });

    return () => {
      cancelled = true;
    };
  }, [desktopBridge]);

  useEffect(() => {
    if (!canManageLocalBackend) return;

    let cancelled = false;
    setIsLoadingDesktopAccessManagement(true);
    type AuthAccessEvent = Parameters<
      Parameters<WsRpcClient["server"]["subscribeAuthAccess"]>[0]
    >[0];
    const unsubscribeAuthAccess =
      getPrimaryEnvironmentConnection().client.server.subscribeAuthAccess(
        (event: AuthAccessEvent) => {
          if (cancelled) {
            return;
          }

          switch (event.type) {
            case "snapshot":
              setDesktopPairingLinks(
                sortDesktopPairingLinks(
                  event.payload.pairingLinks.map((pairingLink: AuthPairingLink) =>
                    toDesktopPairingLinkRecord(pairingLink),
                  ),
                ),
              );
              setDesktopClientSessions(
                sortDesktopClientSessions(
                  event.payload.clientSessions.map((clientSession: AuthClientSession) =>
                    toDesktopClientSessionRecord(clientSession),
                  ),
                ),
              );
              break;
            case "pairingLinkUpserted":
              setDesktopPairingLinks((current) =>
                upsertDesktopPairingLink(current, toDesktopPairingLinkRecord(event.payload)),
              );
              break;
            case "pairingLinkRemoved":
              setDesktopPairingLinks((current) =>
                removeDesktopPairingLink(current, event.payload.id),
              );
              break;
            case "clientUpserted":
              setDesktopClientSessions((current) =>
                upsertDesktopClientSession(current, toDesktopClientSessionRecord(event.payload)),
              );
              break;
            case "clientRemoved":
              setDesktopClientSessions((current) =>
                removeDesktopClientSession(current, event.payload.sessionId),
              );
              break;
          }

          setDesktopAccessManagementError(null);
          setIsLoadingDesktopAccessManagement(false);
        },
        {
          onResubscribe: () => {
            if (!cancelled) {
              setIsLoadingDesktopAccessManagement(true);
            }
          },
        },
      );
    if (desktopBridge) {
      void desktopBridge
        .getServerExposureState()
        .then((state) => {
          if (cancelled) return;
          setDesktopServerExposureState(state);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          const message =
            error instanceof Error ? error.message : "Failed to load network exposure state.";
          setDesktopServerExposureError(message);
        });
      void desktopBridge
        .getAdvertisedEndpoints()
        .then((endpoints) => {
          if (cancelled) return;
          setDesktopAdvertisedEndpoints(endpoints);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          const message =
            error instanceof Error ? error.message : "Failed to load reachable endpoints.";
          setDesktopServerExposureError(message);
        });
    } else {
      setDesktopServerExposureState(null);
      setDesktopAdvertisedEndpoints([]);
      setDesktopServerExposureError(null);
    }

    return () => {
      cancelled = true;
      unsubscribeAuthAccess();
    };
  }, [canManageLocalBackend, desktopBridge]);

  useEffect(() => {
    if (canManageLocalBackend) return;
    setIsLoadingDesktopAccessManagement(false);
    setDesktopPairingLinks([]);
    setDesktopClientSessions([]);
    setDesktopAccessManagementError(null);
    setDesktopServerExposureState(null);
    setDesktopAdvertisedEndpoints([]);
    setDesktopServerExposureError(null);
  }, [canManageLocalBackend]);
  const visibleDesktopPairingLinks = useMemo(
    () => desktopPairingLinks.filter((pairingLink) => pairingLink.role === "client"),
    [desktopPairingLinks],
  );
  const visibleDesktopAdvertisedEndpoints = useMemo(
    () => (isLocalBackendNetworkAccessible ? desktopAdvertisedEndpoints : []),
    [desktopAdvertisedEndpoints, isLocalBackendNetworkAccessible],
  );
  const defaultDesktopAdvertisedEndpoint = useMemo(
    () => selectPairingEndpoint(visibleDesktopAdvertisedEndpoints, defaultAdvertisedEndpointKey),
    [defaultAdvertisedEndpointKey, visibleDesktopAdvertisedEndpoints],
  );
  const defaultDesktopAdvertisedEndpointKey = defaultDesktopAdvertisedEndpoint
    ? endpointDefaultPreferenceKey(defaultDesktopAdvertisedEndpoint)
    : null;
  const handleSetDefaultAdvertisedEndpoint = useCallback(
    (endpoint: AdvertisedEndpoint) => {
      setDefaultAdvertisedEndpointKey(endpointDefaultPreferenceKey(endpoint));
    },
    [setDefaultAdvertisedEndpointKey],
  );
  return (
    <SettingsPageContainer>
      {canManageLocalBackend ? (
        <>
          <SettingsSection title="Manage local backend">
            {desktopBridge ? (
              <>
                <SettingsRow
                  title="Network access"
                  description={
                    isLocalBackendNetworkAccessible ? (
                      <NetworkAccessDescription
                        endpoint={defaultDesktopAdvertisedEndpoint}
                        hiddenEndpointCount={Math.max(
                          visibleDesktopAdvertisedEndpoints.length - 1,
                          0,
                        )}
                        expanded={isAdvertisedEndpointListExpanded}
                        onToggleExpanded={() =>
                          setIsAdvertisedEndpointListExpanded((expanded) => !expanded)
                        }
                        fallback={
                          desktopServerExposureState?.endpointUrl
                            ? `Reachable at ${desktopServerExposureState.endpointUrl}`
                            : desktopServerExposureState?.advertisedHost
                              ? `Exposed on all interfaces. Pairing links use ${desktopServerExposureState.advertisedHost}.`
                              : "Exposed on all interfaces."
                        }
                      />
                    ) : desktopServerExposureState ? (
                      "Limited to this machine."
                    ) : (
                      "Loading…"
                    )
                  }
                  status={
                    desktopServerExposureError ? (
                      <span className="block text-destructive">{desktopServerExposureError}</span>
                    ) : null
                  }
                  control={
                    <AlertDialog
                      open={pendingDesktopServerExposureMode !== null}
                      onOpenChange={(open) => {
                        if (isUpdatingDesktopServerExposure) return;
                        if (!open) setPendingDesktopServerExposureMode(null);
                      }}
                    >
                      <Switch
                        checked={desktopServerExposureState?.mode === "network-accessible"}
                        disabled={!desktopServerExposureState || isUpdatingDesktopServerExposure}
                        onCheckedChange={(checked) => {
                          setPendingDesktopServerExposureMode(
                            checked ? "network-accessible" : "local-only",
                          );
                        }}
                        aria-label="Enable network access"
                      />
                      <AlertDialogPopup>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            {pendingDesktopServerExposureMode === "network-accessible"
                              ? "Enable network access?"
                              : "Disable network access?"}
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            {pendingDesktopServerExposureMode === "network-accessible"
                              ? "T3 Code will restart to expose this environment over the network."
                              : "T3 Code will restart and limit this environment back to this machine."}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogClose
                            disabled={isUpdatingDesktopServerExposure}
                            render={
                              <Button
                                variant="outline"
                                disabled={isUpdatingDesktopServerExposure}
                              />
                            }
                          >
                            Cancel
                          </AlertDialogClose>
                          <Button
                            onClick={handleConfirmDesktopServerExposureChange}
                            disabled={
                              pendingDesktopServerExposureMode === null ||
                              isUpdatingDesktopServerExposure
                            }
                          >
                            {isUpdatingDesktopServerExposure ? (
                              <>
                                <Spinner className="size-3.5" />
                                Restarting…
                              </>
                            ) : pendingDesktopServerExposureMode === "network-accessible" ? (
                              "Restart and enable"
                            ) : (
                              "Restart and disable"
                            )}
                          </Button>
                        </AlertDialogFooter>
                      </AlertDialogPopup>
                    </AlertDialog>
                  }
                />
                {isAdvertisedEndpointListExpanded
                  ? visibleDesktopAdvertisedEndpoints.map((endpoint) => {
                      const endpointKey = endpointDefaultPreferenceKey(endpoint);
                      return (
                        <AdvertisedEndpointListRow
                          key={endpoint.id}
                          endpoint={endpoint}
                          isDefault={endpointKey === defaultDesktopAdvertisedEndpointKey}
                          onSetDefault={handleSetDefaultAdvertisedEndpoint}
                        />
                      );
                    })
                  : null}
              </>
            ) : (
              <SettingsRow
                title="Network access"
                description={
                  currentAuthPolicy === "remote-reachable"
                    ? "This backend is already configured for remote access. Network exposure changes must be made where the server is launched."
                    : "This backend is only reachable on this machine. Restart it with a non-loopback host to enable remote pairing."
                }
                control={
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="inline-flex">
                          <Switch
                            checked={isLocalBackendNetworkAccessible}
                            disabled
                            aria-label="Enable network access"
                          />
                        </span>
                      }
                    />
                    <TooltipPopup side="top">
                      Network exposure changes restart the backend and must be controlled where the
                      server process is launched.
                    </TooltipPopup>
                  </Tooltip>
                }
              />
            )}
          </SettingsSection>

          {isLocalBackendNetworkAccessible ? (
            <SettingsSection
              title="Authorized clients"
              headerAction={
                <AuthorizedClientsHeaderAction
                  clientSessions={desktopClientSessions}
                  isRevokingOtherClients={isRevokingOtherDesktopClients}
                  onRevokeOtherClients={handleRevokeOtherDesktopClients}
                />
              }
            >
              {desktopAccessManagementError ? (
                <div className={ITEM_ROW_CLASSNAME}>
                  <p className="text-xs text-destructive">{desktopAccessManagementError}</p>
                </div>
              ) : null}
              <PairingClientsList
                endpointUrl={desktopServerExposureState?.endpointUrl}
                endpoints={visibleDesktopAdvertisedEndpoints}
                defaultEndpointKey={defaultDesktopAdvertisedEndpointKey}
                isLoading={isLoadingDesktopAccessManagement}
                pairingLinks={visibleDesktopPairingLinks}
                clientSessions={desktopClientSessions}
                revokingPairingLinkId={revokingDesktopPairingLinkId}
                revokingClientSessionId={revokingDesktopClientSessionId}
                onRevokePairingLink={handleRevokeDesktopPairingLink}
                onRevokeClientSession={handleRevokeDesktopClientSession}
              />
            </SettingsSection>
          ) : null}
        </>
      ) : (
        <SettingsSection title="Local backend access">
          <SettingsRow
            title="Owner tools"
            description="Pairing links and client-session management are only available to owner sessions for this backend."
          />
        </SettingsSection>
      )}

      <SettingsSection
        title="Remote environments"
        headerAction={
          <Dialog
            open={addBackendDialogOpen}
            onOpenChange={(open) => {
              setAddBackendDialogOpen(open);
              if (!open) {
                setSavedBackendError(null);
              }
            }}
          >
            <DialogTrigger
              render={
                <Button size="xs" variant="outline">
                  <PlusIcon className="size-3" />
                  Add environment
                </Button>
              }
            />
            <DialogPopup className="max-h-[80dvh] sm:max-w-3xl">
              <DialogHeader>
                <DialogTitle>Add Environment</DialogTitle>
                <DialogDescription>Pair another environment to this client.</DialogDescription>
                <div className="flex gap-1 rounded-lg border border-border/60 bg-muted/50 p-1">
                  <button
                    type="button"
                    className={cn(
                      "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                      savedBackendMode === "pairing-url"
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    disabled={isAddingSavedBackend}
                    onClick={() => setSavedBackendMode("pairing-url")}
                  >
                    Pairing URL
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                      savedBackendMode === "host-code"
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    disabled={isAddingSavedBackend}
                    onClick={() => setSavedBackendMode("host-code")}
                  >
                    Host + code
                  </button>
                  {desktopBridge ? (
                    <button
                      type="button"
                      className={cn(
                        "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                        savedBackendMode === "ssh"
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      disabled={isAddingSavedBackend}
                      onClick={() => setSavedBackendMode("ssh")}
                    >
                      SSH
                    </button>
                  ) : null}
                </div>
              </DialogHeader>
              <DialogPanel>
                <div className="space-y-4">
                  {savedBackendMode === "pairing-url" ? (
                    <p className="text-xs text-muted-foreground">
                      Enter the full pairing URL from the environment you want to connect to.
                    </p>
                  ) : savedBackendMode === "host-code" ? (
                    <p className="text-xs text-muted-foreground">
                      Enter the backend host and pairing code separately.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Connect over SSH using an existing alias from <code>~/.ssh/config</code> or
                      enter a host directly. T3 uses your current SSH agent and config.
                    </p>
                  )}
                  {savedBackendMode === "pairing-url" ? (
                    <div className="space-y-3">
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-foreground">
                          Label
                        </span>
                        <Input
                          value={savedBackendLabel}
                          onChange={(event) => setSavedBackendLabel(event.target.value)}
                          placeholder="My backend (optional)"
                          disabled={isAddingSavedBackend}
                          spellCheck={false}
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-foreground">
                          Pairing URL
                        </span>
                        <Input
                          value={savedBackendPairingUrl}
                          onChange={(event) => setSavedBackendPairingUrl(event.target.value)}
                          placeholder="https://backend.example.com/pair#token=..."
                          disabled={isAddingSavedBackend}
                          spellCheck={false}
                        />
                        <span className="mt-1 block text-[11px] text-muted-foreground">
                          The full URL including the pairing token.
                        </span>
                      </label>
                    </div>
                  ) : savedBackendMode === "host-code" ? (
                    <div className="space-y-3">
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-foreground">
                          Label
                        </span>
                        <Input
                          value={savedBackendLabel}
                          onChange={(event) => setSavedBackendLabel(event.target.value)}
                          placeholder="My backend (optional)"
                          disabled={isAddingSavedBackend}
                          spellCheck={false}
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-foreground">
                          Host
                        </span>
                        <Input
                          value={savedBackendHost}
                          onChange={(event) => setSavedBackendHost(event.target.value)}
                          placeholder="https://backend.example.com"
                          disabled={isAddingSavedBackend}
                          spellCheck={false}
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-foreground">
                          Pairing code
                        </span>
                        <Input
                          value={savedBackendPairingCode}
                          onChange={(event) => setSavedBackendPairingCode(event.target.value)}
                          placeholder="Pairing code"
                          disabled={isAddingSavedBackend}
                          spellCheck={false}
                        />
                      </label>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h3 className="text-sm font-medium text-foreground">Discovered hosts</h3>
                          <p className="text-xs text-muted-foreground">
                            From <code>~/.ssh/config</code> and <code>known_hosts</code>.
                          </p>
                        </div>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={isLoadingDiscoveredSshHosts}
                          onClick={() => void loadDiscoveredSshHosts()}
                        >
                          {isLoadingDiscoveredSshHosts ? (
                            <RefreshCwIcon className="size-3 animate-spin" />
                          ) : (
                            <RefreshCwIcon className="size-3" />
                          )}
                          Refresh
                        </Button>
                      </div>
                      {discoveredSshHostsError ? (
                        <p className="text-xs text-destructive">{discoveredSshHostsError}</p>
                      ) : null}
                      <ScrollArea scrollFade className="max-h-64">
                        <div>
                          {discoveredSshHosts.map((target) => (
                            <DesktopSshHostRow
                              key={`${target.alias}:${target.hostname}:${target.port ?? ""}`}
                              target={target}
                              savedRecord={savedDesktopSshEnvironmentsByAlias[target.alias] ?? null}
                              connectingHostAlias={connectingSshHostAlias}
                              onConnect={(nextTarget) => void handleConnectSshHost(nextTarget)}
                            />
                          ))}
                          {hasLoadedDiscoveredSshHosts &&
                          !isLoadingDiscoveredSshHosts &&
                          discoveredSshHosts.length === 0 ? (
                            <div className={ITEM_ROW_CLASSNAME}>
                              <p className="text-xs text-muted-foreground">
                                No SSH hosts were discovered from <code>~/.ssh/config</code> or{" "}
                                <code>known_hosts</code>.
                              </p>
                            </div>
                          ) : null}
                        </div>
                      </ScrollArea>
                      {savedBackendError ? (
                        <p className="text-xs text-destructive">{savedBackendError}</p>
                      ) : null}
                      <div className="border-t border-border/60 pt-4">
                        <h3 className="mb-1 text-sm font-medium text-foreground">
                          Enter a host manually
                        </h3>
                        <p className="mb-3 text-xs text-muted-foreground">
                          Use an alias or enter host, username, and port directly.
                        </p>
                        <div className="space-y-3">
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-foreground">
                              Label
                            </span>
                            <Input
                              value={savedBackendLabel}
                              onChange={(event) => setSavedBackendLabel(event.target.value)}
                              placeholder="My backend (optional)"
                              disabled={isAddingSavedBackend}
                              spellCheck={false}
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-foreground">
                              SSH host or alias
                            </span>
                            <Input
                              value={savedBackendSshHost}
                              onChange={(event) => setSavedBackendSshHost(event.target.value)}
                              placeholder="devbox or devbox.example.com"
                              disabled={isAddingSavedBackend}
                              spellCheck={false}
                            />
                          </label>
                          <div className="grid gap-3 sm:grid-cols-2">
                            <label className="block">
                              <span className="mb-1.5 block text-xs font-medium text-foreground">
                                Username
                              </span>
                              <Input
                                value={savedBackendSshUsername}
                                onChange={(event) => setSavedBackendSshUsername(event.target.value)}
                                placeholder="julius"
                                disabled={isAddingSavedBackend}
                                spellCheck={false}
                              />
                            </label>
                            <label className="block">
                              <span className="mb-1.5 block text-xs font-medium text-foreground">
                                Port
                              </span>
                              <Input
                                value={savedBackendSshPort}
                                onChange={(event) => setSavedBackendSshPort(event.target.value)}
                                placeholder="22"
                                inputMode="numeric"
                                disabled={isAddingSavedBackend}
                                spellCheck={false}
                              />
                            </label>
                          </div>
                          <span className="block text-[11px] text-muted-foreground">
                            Uses your existing SSH keys, agent, and config. Password and
                            keyboard-interactive prompts open through your system SSH dialog when
                            needed.
                          </span>
                          <Button
                            variant="outline"
                            className="w-full"
                            disabled={isAddingSavedBackend}
                            onClick={() => void handleAddSavedBackend()}
                          >
                            <PlusIcon className="size-3.5" />
                            {isAddingSavedBackend ? "Connecting…" : "Connect SSH host"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                  {savedBackendMode !== "ssh" && savedBackendError ? (
                    <p className="text-xs text-destructive">{savedBackendError}</p>
                  ) : null}
                  {savedBackendMode !== "ssh" ? (
                    <Button
                      variant="outline"
                      className="w-full"
                      disabled={isAddingSavedBackend}
                      onClick={() => void handleAddSavedBackend()}
                    >
                      <PlusIcon className="size-3.5" />
                      {isAddingSavedBackend ? "Adding…" : "Add Backend"}
                    </Button>
                  ) : null}
                </div>
              </DialogPanel>
            </DialogPopup>
          </Dialog>
        }
      >
        {savedEnvironmentIds.map((environmentId) => (
          <SavedBackendListRow
            key={environmentId}
            environmentId={environmentId}
            reconnectingEnvironmentId={reconnectingSavedEnvironmentId}
            removingEnvironmentId={removingSavedEnvironmentId}
            onReconnect={handleReconnectSavedBackend}
            onRemove={handleRemoveSavedBackend}
          />
        ))}

        {savedEnvironmentIds.length === 0 ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              No remote environments yet. Click &ldquo;Add environment&rdquo; to pair another
              environment.
            </p>
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
