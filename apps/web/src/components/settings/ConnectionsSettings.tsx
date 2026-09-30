import {
  ChevronRightIcon,
  EllipsisIcon,
  KeyboardIcon,
  LaptopIcon,
  Link2Icon,
  MonitorSmartphoneIcon,
  PlusIcon,
  QrCodeIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  Trash2Icon,
} from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  type AuthClientSession,
  type AuthPairingLink,
  type DesktopServerExposureState,
  type EnvironmentId,
} from "@t3tools/contracts";
import { DateTime } from "effect";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { DesktopConnectAccountSettings } from "./DesktopConnectAccountSettings";
import { cn } from "../../lib/utils";
import { formatElapsedDurationLabel, formatExpiresInLabel } from "../../timestampFormat";
import {
  SettingsPageContainer,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { setPairingTokenOnUrl } from "../../pairingUrl";
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
import { Badge } from "../ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
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
  getPrimaryEnvironmentConnection,
  reconnectSavedEnvironment,
  setSavedEnvironmentEnabled,
  removeSavedEnvironment,
} from "~/environments/runtime";
import { MobilePairingDialog } from "./MobilePairingDialog";
import { RemoteAccessSettings } from "./RemoteAccessSettings";
import { connectAccountManagementUrl } from "../../cloud/connectCliAuth";
import { CONNECT_ACTION_HELP } from "@t3tools/shared/connectManagement";
import { LocalEnvironmentsSettings } from "./LocalEnvironmentsSettings";
import { resolveCurrentOriginPairingUrl, useMobilePairing } from "./useMobilePairing";

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
            "absolute inline-flex h-full w-full animate-status-ping rounded-full",
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

/**
 * Shared list rhythm for every Connections list, borrowed from upstream's
 * EnvironmentRow: one leading icon, a title + status line, and actions that
 * sit right on desktop and wrap underneath on mobile.
 */
function ConnectionListRow({
  icon,
  title,
  meta,
  error,
  actions,
  dimmed = false,
}: {
  icon: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  error?: ReactNode;
  actions?: ReactNode;
  dimmed?: boolean;
}) {
  return (
    <div className={cn("px-4 py-4 sm:px-5", dimmed && "opacity-70")}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-muted-foreground">
            {icon}
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">{title}</div>
            {meta}
            {error}
          </div>
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2 pl-11 sm:pl-0">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}

type StatusPillTone = "live" | "pending" | "error" | "muted";

const STATUS_PILL_TONE_CLASSNAME: Record<StatusPillTone, string> = {
  live: "border-success/30 bg-success/10 text-success-foreground",
  pending: "border-warning/30 bg-warning/10 text-warning-foreground",
  error: "border-destructive/30 bg-destructive/10 text-destructive",
  muted: "border-border/60 bg-muted/50 text-muted-foreground",
};

function StatusPill({
  tone,
  dotClassName,
  pingClassName,
  label,
  tooltipText,
}: {
  tone: StatusPillTone;
  dotClassName: string;
  pingClassName?: string | null;
  label: string;
  tooltipText?: string | null;
}) {
  return (
    <span
      title={tooltipText ?? undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap",
        STATUS_PILL_TONE_CLASSNAME[tone],
      )}
    >
      <ConnectionStatusDot dotClassName={dotClassName} pingClassName={pingClassName ?? null} />
      {label}
    </span>
  );
}

/**
 * Local equivalent of upstream's FoldedSettingsSection: the section starts
 * collapsed behind a summary line so pairing details don't crowd the page.
 * `autoOpen` covers data that arrives after mount (e.g. pairing links from
 * the auth subscription): the section opens once it turns true unless the
 * user already toggled it by hand.
 */
function CollapsibleSettingsSection({
  title,
  description,
  summary,
  headerAction,
  defaultOpen = false,
  autoOpen = false,
  children,
}: {
  title: string;
  description?: string;
  summary?: string | null;
  headerAction?: ReactNode;
  defaultOpen?: boolean;
  autoOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [userToggled, setUserToggled] = useState(false);
  useEffect(() => {
    if (autoOpen && !userToggled) {
      setOpen(true);
    }
  }, [autoOpen, userToggled]);
  return (
    <section className="space-y-2.5">
      <div className="flex items-start justify-between gap-3 px-1">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground/50">
            <span className="inline-block h-px w-3 bg-border" aria-hidden />
            {title}
          </h2>
          {description ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">{description}</p>
          ) : null}
        </div>
        {headerAction ? <div className="flex shrink-0 items-center">{headerAction}</div> : null}
      </div>
      <div className="relative overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm/4 not-dark:bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:shadow-none dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
        <Collapsible
          open={open}
          onOpenChange={(next) => {
            setUserToggled(true);
            setOpen(next);
          }}
        >
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left outline-none sm:px-5">
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
            <span className="shrink-0 text-sm font-medium text-foreground">
              {open ? "Hide details" : "Show details"}
            </span>
            {summary ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span>
            ) : null}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="divide-y divide-border/60 border-t border-border/60">{children}</div>
          </CollapsiblePanel>
        </Collapsible>
      </div>
    </section>
  );
}

function summarizeAuthorizedClients(
  clientSessions: ReadonlyArray<ServerClientSessionRecord>,
  pairingLinks: ReadonlyArray<ServerPairingLinkRecord>,
): string | null {
  const liveCount = clientSessions.filter((session) => session.current || session.connected).length;
  const bits: Array<string> = [];
  if (liveCount > 0) {
    bits.push(`${liveCount} connected`);
  }
  if (pairingLinks.length > 0) {
    bits.push(`${pairingLinks.length} pending ${pairingLinks.length === 1 ? "link" : "links"}`);
  }
  if (clientSessions.length > liveCount) {
    bits.push(`${clientSessions.length - liveCount} offline`);
  }
  return bits.length > 0 ? bits.join(" · ") : null;
}

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
    role: pairingLink.role ?? "client",
    createdAt: DateTime.formatIso(pairingLink.createdAt),
    expiresAt: DateTime.formatIso(pairingLink.expiresAt),
  };
}

function toDesktopClientSessionRecord(clientSession: AuthClientSession): ServerClientSessionRecord {
  return {
    ...clientSession,
    role: clientSession.role ?? "client",
    method:
      clientSession.method === "browser-session-cookie"
        ? "browser-session-cookie"
        : "bearer-session-token",
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

function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

type PairingLinkListRowProps = {
  pairingLink: ServerPairingLinkRecord;
  endpointUrl: string | null | undefined;
  revokingPairingLinkId: string | null;
  onRevoke: (id: string) => void;
};

const PairingLinkListRow = memo(function PairingLinkListRow({
  pairingLink,
  endpointUrl,
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
  const shareablePairingUrl =
    endpointUrl != null && endpointUrl !== ""
      ? resolveDesktopPairingUrl(endpointUrl, pairingLink.credential)
      : isLoopbackHostname(window.location.hostname)
        ? null
        : currentOriginPairingUrl;
  const copyValue = shareablePairingUrl ?? pairingLink.credential;
  const canCopyToClipboard =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    navigator.clipboard?.writeText != null;

  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: shareablePairingUrl ? "Pairing URL copied" : "Pairing token copied",
        description: shareablePairingUrl
          ? "Open it in the client you want to pair to this environment."
          : "Paste it into another client with this backend's reachable host.",
      });
    },
    onError: (error) => {
      setIsRevealDialogOpen(true);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: canCopyToClipboard ? "Could not copy pairing URL" : "Clipboard copy unavailable",
          description: canCopyToClipboard ? error.message : "Showing the full value instead.",
        }),
      );
    },
  });

  const handleCopy = useCallback(() => {
    copyToClipboard(copyValue, undefined);
  }, [copyToClipboard, copyValue]);

  const expiresAbsolute = formatAccessTimestamp(pairingLink.expiresAt);

  const roleLabel = pairingLink.role === "owner" ? "Owner" : "Client";
  const primaryLabel = pairingLink.label ?? `${roleLabel} link`;

  if (expiresAtMs <= nowMs) {
    return null;
  }

  return (
    <ConnectionListRow
      icon={<Link2Icon aria-hidden className="size-4" />}
      title={
        <>
          <h3 className="truncate text-sm font-medium text-foreground">{primaryLabel}</h3>
          <StatusPill
            tone="pending"
            dotClassName="bg-amber-400"
            label={formatExpiresInLabel(pairingLink.expiresAt, nowMs)}
            tooltipText={`Link created at ${formatAccessTimestamp(pairingLink.createdAt)} · Expires ${expiresAbsolute}`}
          />
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
        </>
      }
      meta={
        <>
          <p className="text-xs text-muted-foreground" title={expiresAbsolute}>
            {roleLabel} pairing link
          </p>
          {shareablePairingUrl === null ? (
            <p className="text-[11px] text-muted-foreground/70">
              Copy the token and pair from another client using this backend&apos;s reachable host.
            </p>
          ) : null}
        </>
      }
      actions={
        <>
          <Dialog open={isRevealDialogOpen} onOpenChange={setIsRevealDialogOpen}>
            {canCopyToClipboard ? (
              <Button size="sm" variant="outline" onClick={handleCopy}>
                {isCopied ? "Copied" : shareablePairingUrl ? "Copy link" : "Copy token"}
              </Button>
            ) : (
              <DialogTrigger render={<Button size="sm" variant="outline" />}>
                {shareablePairingUrl ? "Show link" : "Show token"}
              </DialogTrigger>
            )}
            <DialogPopup className="max-w-md">
              <DialogHeader>
                <DialogTitle>{shareablePairingUrl ? "Pairing link" : "Pairing token"}</DialogTitle>
                <DialogDescription>
                  {shareablePairingUrl
                    ? "Clipboard copy is unavailable here. Open or manually copy this full pairing URL on the device you want to connect."
                    : "Clipboard copy is unavailable here. Manually copy this token and pair from another client using this backend's reachable host."}
                </DialogDescription>
              </DialogHeader>
              <DialogPanel className="space-y-4">
                <Textarea
                  readOnly
                  value={copyValue}
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
                  <Button variant="outline" size="xs" onClick={handleCopy}>
                    {isCopied ? "Copied" : "Copy again"}
                  </Button>
                ) : null}
              </DialogFooter>
            </DialogPopup>
          </Dialog>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            disabled={revokingPairingLinkId === pairingLink.id}
            onClick={() => void onRevoke(pairingLink.id)}
          >
            {revokingPairingLinkId === pairingLink.id ? "Revoking…" : "Revoke"}
          </Button>
        </>
      }
    />
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
    <ConnectionListRow
      icon={<SmartphoneIcon aria-hidden className="size-4" />}
      title={
        <>
          <h3 className="truncate text-sm font-medium text-foreground">{primaryLabel}</h3>
          <StatusPill
            tone={isLive ? "live" : "muted"}
            dotClassName={isLive ? "bg-success" : "bg-muted-foreground/30"}
            pingClassName={isLive ? "bg-success/60 duration-2000" : null}
            label={isLive ? "Connected" : "Offline"}
            tooltipText={statusTooltip}
          />
          {clientSession.current ? (
            <Badge variant="outline" size="sm">
              This device
            </Badge>
          ) : null}
        </>
      }
      meta={
        <p
          className="truncate text-xs text-muted-foreground"
          title={[roleLabel, ...deviceInfoBits].join(" · ")}
        >
          {[roleLabel, ...deviceInfoBits].join(" · ")}
        </p>
      }
      actions={
        !clientSession.current ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            disabled={revokingClientSessionId === clientSession.sessionId}
            onClick={() => void onRevokeSession(clientSession.sessionId)}
          >
            {revokingClientSessionId === clientSession.sessionId ? "Revoking…" : "Revoke"}
          </Button>
        ) : undefined
      }
    />
  );
});

type AuthorizedClientsHeaderActionProps = {
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  isRevokingOtherClients: boolean;
  onRevokeOtherClients: () => void;
  isCreatingMobilePairing: boolean;
  canCreateMobilePairing: boolean;
  onCreateMobilePairing: () => void;
};

const AuthorizedClientsHeaderAction = memo(function AuthorizedClientsHeaderAction({
  clientSessions,
  isRevokingOtherClients,
  onRevokeOtherClients,
  isCreatingMobilePairing,
  canCreateMobilePairing,
  onCreateMobilePairing,
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

  const canRevokeOthers =
    !isRevokingOtherClients && clientSessions.some((clientSession) => !clientSession.current);

  return (
    <div className="flex items-center gap-1.5">
      <Button
        size="sm"
        variant="outline"
        disabled={isCreatingMobilePairing || !canCreateMobilePairing}
        onClick={onCreateMobilePairing}
        title={
          canCreateMobilePairing
            ? "Show a QR code to pair a phone or tablet on your local network"
            : "Enable local network access before pairing over LAN"
        }
      >
        {isCreatingMobilePairing ? (
          <>
            <Spinner className="size-3" />
            Creating…
          </>
        ) : (
          <>
            <QrCodeIcon className="size-3" />
            Pair phone
          </>
        )}
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
            <Button size="sm" variant="default">
              <PlusIcon className="size-3" />
              Create link
            </Button>
          }
        />
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create pairing link</DialogTitle>
            <DialogDescription>
              Generate a one-time link for a phone, tablet, or browser to pair with this machine.
              The link expires automatically.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Device label (optional)
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
      <Menu>
        <MenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              aria-label="More device actions"
            />
          }
        >
          <EllipsisIcon className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-48">
          <MenuItem disabled={!canRevokeOthers} onClick={() => void onRevokeOtherClients()}>
            <Trash2Icon aria-hidden className="size-3.5" />
            {isRevokingOtherClients ? "Revoking…" : "Revoke all other devices"}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
});

type PairingClientsListProps = {
  endpointUrl: string | null | undefined;
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
        <Empty className="gap-0 p-6">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MonitorSmartphoneIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>No paired devices yet</EmptyTitle>
            <EmptyDescription>
              Create a pairing link or pair your phone to see devices here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
    </>
  );
});

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
  const [isSwitching, setIsSwitching] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const nowMs = useRelativeTimeTick(1_000);
  const record = useSavedEnvironmentRegistryStore((state) => state.byId[environmentId] ?? null);
  const runtime = useSavedEnvironmentRuntimeStore((state) => state.byId[environmentId] ?? null);

  if (!record) {
    return null;
  }

  const enabled = record.enabled !== false;
  const connectionState = enabled ? (runtime?.connectionState ?? "disconnected") : "disconnected";
  const statusPill =
    connectionState === "connected" ? (
      <StatusPill
        tone="live"
        dotClassName="bg-success"
        label="Connected"
        tooltipText={getSavedBackendStatusTooltip(runtime, record, nowMs)}
      />
    ) : connectionState === "connecting" ? (
      <StatusPill
        tone="pending"
        dotClassName="bg-warning"
        pingClassName="bg-warning/60 duration-2000"
        label="Connecting"
        tooltipText={getSavedBackendStatusTooltip(runtime, record, nowMs)}
      />
    ) : connectionState === "error" ? (
      <StatusPill
        tone="error"
        dotClassName="bg-destructive"
        label="Connection error"
        tooltipText={getSavedBackendStatusTooltip(runtime, record, nowMs)}
      />
    ) : (
      <StatusPill
        tone="muted"
        dotClassName="bg-muted-foreground/40"
        label={enabled ? "Offline" : "Paused"}
        tooltipText={
          enabled ? getSavedBackendStatusTooltip(runtime, record, nowMs) : "Off on this device"
        }
      />
    );
  const roleLabel = runtime?.role ? (runtime.role === "owner" ? "Owner" : "Client") : null;
  const descriptorLabel = runtime?.descriptor?.label ?? null;
  const metadataBits = [
    roleLabel,
    record.lastConnectedAt
      ? `Last connected ${formatAccessTimestamp(record.lastConnectedAt)}`
      : null,
  ].filter((value): value is string => value !== null);

  return (
    <>
      <ConnectionListRow
        dimmed={!enabled}
        icon={<ServerIcon aria-hidden className="size-4" />}
        title={
          <>
            <h3 className="truncate text-sm font-medium text-foreground">{record.label}</h3>
            {statusPill}
          </>
        }
        meta={
          <>
            {metadataBits.length > 0 ? (
              <p className="text-xs text-muted-foreground">{metadataBits.join(" · ")}</p>
            ) : null}
            {descriptorLabel && descriptorLabel !== record.label ? (
              <p className="text-xs text-muted-foreground">Server label: {descriptorLabel}</p>
            ) : null}
            <p
              className="truncate font-mono text-[11px] text-muted-foreground/80"
              title={record.httpBaseUrl}
            >
              {record.httpBaseUrl}
            </p>
            {enabled && runtime?.lastError ? (
              <p className="truncate text-xs text-destructive" title={runtime.lastError}>
                {runtime.lastError}
              </p>
            ) : null}
          </>
        }
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!enabled || isSwitching || reconnectingEnvironmentId === environmentId}
              onClick={() => void onReconnect(environmentId)}
              title={enabled ? "Retry the connection now" : "Unpause to reconnect"}
            >
              {reconnectingEnvironmentId === environmentId ? (
                <>
                  <RefreshCwIcon aria-hidden className="size-3 animate-spin" />
                  Reconnecting…
                </>
              ) : (
                <>
                  <RefreshCwIcon aria-hidden className="size-3" />
                  Reconnect
                </>
              )}
            </Button>
            <Switch
              aria-label={`Enable ${record.label}`}
              title={enabled ? "Pause without forgetting" : "Resume this connection"}
              checked={enabled}
              disabled={isSwitching || removingEnvironmentId === environmentId}
              onCheckedChange={(checked) => {
                setIsSwitching(true);
                void setSavedEnvironmentEnabled(environmentId, checked)
                  .catch((error) => {
                    toastManager.add({
                      type: "error",
                      title: "Could not change environment connection",
                      description: error instanceof Error ? error.message : String(error),
                    });
                  })
                  .finally(() => setIsSwitching(false));
              }}
            />
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`More actions for ${record.label}`}
                    disabled={removingEnvironmentId === environmentId}
                  />
                }
              >
                <EllipsisIcon className="size-4" />
              </MenuTrigger>
              <MenuPopup align="end" className="min-w-48">
                <MenuItem variant="destructive" onClick={() => setConfirmRemove(true)}>
                  <Trash2Icon aria-hidden className="size-3.5" />
                  Remove from this device
                </MenuItem>
              </MenuPopup>
            </Menu>
          </>
        }
      />
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {record.label} from this device?</AlertDialogTitle>
            <AlertDialogDescription>
              This forgets its saved connection and credential. Pair again to reconnect. Switch it
              off instead to pause without forgetting it. Neither action stops server-side work or
              deregisters the host from your account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmRemove(false);
                onRemove(environmentId);
              }}
            >
              Remove from this device
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function AddEnvironmentModeCard({
  active,
  icon,
  title,
  description,
  onSelect,
  disabled,
}: {
  active: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-3 rounded-xl border p-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-primary/50 bg-primary/5 shadow-xs"
          : "border-border/60 bg-muted/20 hover:border-border hover:bg-muted/40",
        disabled && "opacity-60",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border",
          active
            ? "border-primary/30 bg-background text-foreground"
            : "border-border/60 bg-background/60 text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}

export function ConnectionsSettings() {
  const desktopBridge = window.desktopBridge;
  const [externallyManaged] = useState(
    () => desktopBridge?.getLocalEnvironmentBootstrap?.()?.ownership === "external",
  );
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
        .filter((record) => !record.accountId)
        .toSorted((left, right) => left.label.localeCompare(right.label))
        .map((record) => record.environmentId),
    [savedEnvironmentsById],
  );

  const [desktopServerExposureState, setDesktopServerExposureState] =
    useState<DesktopServerExposureState | null>(null);
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
  const [savedBackendMode, setSavedBackendMode] = useState<"pairing-url" | "host-code">(
    "pairing-url",
  );
  const [savedBackendLabel, setSavedBackendLabel] = useState("");
  const [savedBackendPairingUrl, setSavedBackendPairingUrl] = useState("");
  const [savedBackendHost, setSavedBackendHost] = useState("");
  const [savedBackendPairingCode, setSavedBackendPairingCode] = useState("");
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
  const canManageLocalBackend = currentSessionRole === "owner" && !externallyManaged;
  const isLocalBackendNetworkAccessible = desktopBridge
    ? desktopServerExposureState?.mode === "network-accessible"
    : currentAuthPolicy === "remote-reachable";
  const canShowAuthorizedClients = canManageLocalBackend;
  const localBackendEndpointUrl = desktopBridge
    ? desktopServerExposureState?.endpointUrl
    : currentAuthPolicy === "remote-reachable"
      ? window.location.origin
      : null;
  const {
    createMobilePairing,
    dialogOpen: mobilePairingDialogOpen,
    dialogState: mobilePairingDialogState,
    isCreating: isCreatingMobilePairing,
    setDialogOpen: setMobilePairingDialogOpen,
  } = useMobilePairing({
    canManageLocalBackend,
    desktopBridge,
    desktopServerExposureMode: desktopServerExposureState?.mode,
    localBackendEndpointUrl,
    onDesktopServerExposureState: setDesktopServerExposureState,
  });

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

  const handleCreateMobilePairing = useCallback(async () => {
    setDesktopAccessManagementError(null);
    try {
      await createMobilePairing();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create mobile pairing QR code.";
      setDesktopAccessManagementError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create mobile pairing QR",
          description: message,
        }),
      );
    }
  }, [createMobilePairing]);

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
    } else {
      setDesktopServerExposureState(null);
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
    setDesktopServerExposureError(null);
  }, [canManageLocalBackend]);
  const visibleDesktopPairingLinks = useMemo(
    () => desktopPairingLinks.filter((pairingLink) => pairingLink.role === "client"),
    [desktopPairingLinks],
  );
  const liveClientCount = desktopClientSessions.filter(
    (clientSession) => clientSession.current || clientSession.connected,
  ).length;
  return (
    <SettingsPageContainer width="wide">
      <SettingsPageHeader
        title="Connections"
        description="Pair phones and browsers with this machine, control how it can be reached, and manage the environments this client connects to."
        status={
          <>
            {currentSessionRole ? (
              <Badge variant="outline" size="sm">
                {currentSessionRole === "owner" ? "Owner session" : "Client session"}
              </Badge>
            ) : null}
            <Badge variant="secondary" size="sm">
              {Object.keys(savedEnvironmentsById).length}{" "}
              {Object.keys(savedEnvironmentsById).length === 1 ? "environment" : "environments"}
            </Badge>
            {canManageLocalBackend ? (
              <Badge variant="secondary" size="sm">
                {liveClientCount} {liveClientCount === 1 ? "device" : "devices"} connected
              </Badge>
            ) : null}
          </>
        }
      />
      <LocalEnvironmentsSettings />
      <DesktopConnectAccountSettings />
      {canManageLocalBackend ? (
        <>
          <RemoteAccessSettings />
          <SettingsSection
            title="This machine"
            description="The backend running on this device: your account, and who can reach it over the local network."
            icon={<LaptopIcon aria-hidden className="size-3" />}
          >
            <SettingsRow
              title="T3 Connect account"
              description={`Environments registered to your T3 account. ${CONNECT_ACTION_HELP}`}
              control={
                <Button
                  size="sm"
                  variant="outline"
                  render={
                    <a
                      href={connectAccountManagementUrl()}
                      target="_blank"
                      rel="noopener noreferrer"
                    />
                  }
                >
                  Manage environments
                </Button>
              }
            />
            {desktopBridge ? (
              <SettingsRow
                title="Local network access"
                description={
                  desktopServerExposureState?.endpointUrl
                    ? `Other devices on your network reach this machine at ${desktopServerExposureState.endpointUrl}`
                    : desktopServerExposureState?.mode === "network-accessible"
                      ? desktopServerExposureState.advertisedHost
                        ? `Visible to your local network. Pairing links use ${desktopServerExposureState.advertisedHost}.`
                        : "Visible to your local network."
                      : desktopServerExposureState
                        ? "Only this machine can connect directly. Turn on to pair phones and browsers over your local network."
                        : "Loading…"
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
                            : "T3 Code will restart and disable LAN access. Remote Access is controlled separately."}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogClose
                          disabled={isUpdatingDesktopServerExposure}
                          render={
                            <Button variant="outline" disabled={isUpdatingDesktopServerExposure} />
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
            ) : (
              <SettingsRow
                title="Local network access"
                description={
                  currentAuthPolicy === "remote-reachable"
                    ? "This backend accepts direct network connections. LAN exposure is controlled where the server is launched."
                    : "Only this machine can connect directly. Use Remote Access above to connect through the tunnel without opening a LAN port."
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

          {canShowAuthorizedClients ? (
            <CollapsibleSettingsSection
              title="Devices & pairing"
              description="Phones, tablets, and browsers paired with this machine. Links expire automatically."
              summary={summarizeAuthorizedClients(
                desktopClientSessions,
                visibleDesktopPairingLinks,
              )}
              autoOpen={visibleDesktopPairingLinks.length > 0}
              headerAction={
                <AuthorizedClientsHeaderAction
                  clientSessions={desktopClientSessions}
                  isRevokingOtherClients={isRevokingOtherDesktopClients}
                  onRevokeOtherClients={handleRevokeOtherDesktopClients}
                  isCreatingMobilePairing={isCreatingMobilePairing}
                  canCreateMobilePairing={!!desktopBridge || isLocalBackendNetworkAccessible}
                  onCreateMobilePairing={() => void handleCreateMobilePairing()}
                />
              }
            >
              {desktopAccessManagementError ? (
                <div className="px-4 py-3 sm:px-5">
                  <p className="text-xs text-destructive">{desktopAccessManagementError}</p>
                </div>
              ) : null}
              {!isLocalBackendNetworkAccessible ? (
                <div className="px-4 py-3 sm:px-5">
                  <p className="text-xs text-muted-foreground">
                    Pair over the tunnel with “Pair remote device” above. Pairing links and phone QR
                    codes need local network access.
                  </p>
                </div>
              ) : null}
              <PairingClientsList
                endpointUrl={localBackendEndpointUrl}
                isLoading={isLoadingDesktopAccessManagement}
                pairingLinks={visibleDesktopPairingLinks}
                clientSessions={desktopClientSessions}
                revokingPairingLinkId={revokingDesktopPairingLinkId}
                revokingClientSessionId={revokingDesktopClientSessionId}
                onRevokePairingLink={handleRevokeDesktopPairingLink}
                onRevokeClientSession={handleRevokeDesktopClientSession}
              />
            </CollapsibleSettingsSection>
          ) : null}
          <MobilePairingDialog
            state={mobilePairingDialogState}
            open={mobilePairingDialogOpen}
            onOpenChange={setMobilePairingDialogOpen}
          />
        </>
      ) : (
        <SettingsSection
          title="Devices & pairing"
          description="Phones, tablets, and browsers paired with this machine."
        >
          <div className="flex items-start gap-3 px-4 py-4 sm:px-5">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-muted-foreground">
              <ShieldCheckIcon aria-hidden className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Owner tools hidden</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                Pairing links and device management are only available to owner sessions for this
                backend.
              </p>
            </div>
          </div>
        </SettingsSection>
      )}

      <SettingsSection
        title="Environments"
        description="Other backends this client connects to. Saved connections reconnect automatically on startup."
        icon={<ServerIcon aria-hidden className="size-3" />}
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
                <Button size="sm" variant="outline">
                  <PlusIcon className="size-3" />
                  Add environment
                </Button>
              }
            />
            <DialogPopup className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Add environment</DialogTitle>
                <DialogDescription>
                  Connect this client to another backend. Choose how you want to enter the pairing
                  details.
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <div className="space-y-4">
                  <div
                    role="radiogroup"
                    aria-label="Pairing method"
                    className="grid gap-2 sm:grid-cols-2"
                  >
                    <AddEnvironmentModeCard
                      active={savedBackendMode === "pairing-url"}
                      icon={<Link2Icon aria-hidden className="size-4" />}
                      title="Pairing URL"
                      description="Paste the full link from the other backend."
                      disabled={isAddingSavedBackend}
                      onSelect={() => setSavedBackendMode("pairing-url")}
                    />
                    <AddEnvironmentModeCard
                      active={savedBackendMode === "host-code"}
                      icon={<KeyboardIcon aria-hidden className="size-4" />}
                      title="Host & code"
                      description="Enter the host and pairing code separately."
                      disabled={isAddingSavedBackend}
                      onSelect={() => setSavedBackendMode("host-code")}
                    />
                  </div>
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
                    {savedBackendMode === "pairing-url" ? (
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
                    ) : (
                      <>
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
                      </>
                    )}
                  </div>
                  {savedBackendError ? (
                    <p className="text-xs text-destructive">{savedBackendError}</p>
                  ) : null}
                </div>
              </DialogPanel>
              <DialogFooter variant="bare">
                <Button
                  variant="outline"
                  disabled={isAddingSavedBackend}
                  onClick={() => setAddBackendDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  disabled={isAddingSavedBackend}
                  onClick={() => void handleAddSavedBackend()}
                >
                  <PlusIcon className="size-3.5" />
                  {isAddingSavedBackend ? "Adding…" : "Add environment"}
                </Button>
              </DialogFooter>
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
          <Empty className="gap-0 p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ServerIcon aria-hidden />
              </EmptyMedia>
              <EmptyTitle>No other environments yet</EmptyTitle>
              <EmptyDescription>
                Add another backend to switch between machines from this client.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
