import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  TailcatConnectionCodeResult,
  TailcatRemoteAccessState,
  TailcatTrustedPeer,
} from "@t3tools/contracts";
import { CopyIcon, EllipsisIcon, PlusIcon } from "lucide-react";
import { memo, useCallback, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { formatExpiresInLabel } from "../../timestampFormat";
import { useEnvironmentQuery } from "~/state/query";
import { tailcatEnvironment } from "~/state/tailcat";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { QRCodeSvg } from "../ui/qr-code";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatFederationTimestamp } from "./FederationSection.logic";
import { SettingsRow, useRelativeTimeTick } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  connectionCodeLifetimeMinutes,
  formatTailcatConnectionError,
  tailcatDiagnosticsJson,
  tailcatNodeKeyFingerprint,
  tailcatRuntimeLabel,
  tailcatStatusBadgeVariant,
  tailcatStatusLabel,
} from "./TailcatRemoteAccess.logic";

interface IssuedConnectionCode {
  readonly result: TailcatConnectionCodeResult;
  readonly lifetimeMinutes: number;
}

type TrustedPeerRowProps = {
  readonly peer: TailcatTrustedPeer;
  readonly busy: boolean;
  readonly onRename: (peerId: string, label: string) => Promise<boolean>;
  readonly onRevoke: (peerId: string) => void;
};

const TrustedPeerRow = memo(function TrustedPeerRow({
  peer,
  busy,
  onRename,
  onRevoke,
}: TrustedPeerRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftLabel, setDraftLabel] = useState(peer.label);
  const [isSaving, setIsSaving] = useState(false);

  const startEditing = useCallback(() => {
    setDraftLabel(peer.label);
    setIsEditing(true);
  }, [peer.label]);

  const saveLabel = useCallback(async () => {
    const label = draftLabel.trim();
    if (label.length === 0 || label === peer.label) {
      setIsEditing(false);
      return;
    }
    setIsSaving(true);
    const renamed = await onRename(peer.id, label);
    setIsSaving(false);
    if (renamed) setIsEditing(false);
  }, [draftLabel, onRename, peer.id, peer.label]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1 space-y-0.5">
        {isEditing ? (
          <Input
            size="sm"
            value={draftLabel}
            autoFocus
            disabled={isSaving}
            aria-label="Device label"
            onChange={(event) => setDraftLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void saveLabel();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setIsEditing(false);
              }
            }}
          />
        ) : (
          <h4 className="truncate text-sm font-medium text-foreground">{peer.label}</h4>
        )}
        <p className="truncate text-xs text-muted-foreground">
          <span className="font-mono">…{tailcatNodeKeyFingerprint(peer.nodeKey)}</span>
          <span aria-hidden> · </span>
          {peer.lastSeenAt
            ? `Last seen ${formatFederationTimestamp(peer.lastSeenAt)}`
            : "Not connected yet"}
          {peer.sessionIds.length > 0 ? (
            <>
              <span aria-hidden> · </span>
              {peer.sessionIds.length === 1 ? "1 session" : `${peer.sessionIds.length} sessions`}
            </>
          ) : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {isEditing ? (
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={isSaving}
              onClick={() => setIsEditing(false)}
            >
              Cancel
            </Button>
            <Button size="xs" disabled={isSaving} onClick={() => void saveLabel()}>
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </>
        ) : (
          <>
            <Button size="xs" variant="outline" disabled={busy} onClick={startEditing}>
              Rename
            </Button>
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => onRevoke(peer.id)}
            >
              {busy ? "Revoking…" : "Revoke"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
});

/** The freshly minted code, its QR, and a live countdown. Ticks only while a code is on screen. */
const ConnectionCodeReveal = memo(function ConnectionCodeReveal({
  issued,
}: {
  readonly issued: IssuedConnectionCode;
}) {
  const nowMs = useRelativeTimeTick(1_000);
  const expiresAtMs = Date.parse(issued.result.expiresAt);
  const { copyToClipboard } = useCopyToClipboard<void>({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Connection code copied",
        description:
          "Paste it in the desktop app on the other device under Add environment → Tailcat.",
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy connection code",
          description: error.message,
        }),
      );
    },
  });

  if (expiresAtMs <= nowMs) {
    return (
      <p className="text-xs text-muted-foreground">
        That code expired unused. Create a new one when the other device is ready.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1 space-y-2">
        <Textarea
          readOnly
          value={issued.result.code}
          rows={4}
          aria-label="Tailcat connection code"
          className="font-mono text-[11px] leading-relaxed break-all"
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.currentTarget.select()}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs" variant="outline" onClick={() => copyToClipboard(issued.result.code)}>
            <CopyIcon aria-hidden />
            Copy code
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {formatExpiresInLabel(issued.result.expiresAt, nowMs)} · single use, expires in{" "}
            {issued.lifetimeMinutes} min
          </span>
        </div>
      </div>
      <div className="w-fit shrink-0 self-center rounded-xl bg-white p-3 sm:self-start">
        <QRCodeSvg
          value={issued.result.code}
          size={168}
          level="L"
          marginSize={1}
          title="Tailcat connection code"
        />
      </div>
    </div>
  );
});

type TailcatRemoteAccessRowProps = {
  readonly environmentId: EnvironmentId;
};

/**
 * "This environment" card for serving over Tailcat: enable/disable, the
 * address other devices dial, one-time connection codes, the devices trusted
 * so far, and the identity reset. Everything here is server state; the card is
 * the same in the desktop app, the local web app, and the hosted app.
 */
export const TailcatRemoteAccessRow = memo(function TailcatRemoteAccessRow({
  environmentId,
}: TailcatRemoteAccessRowProps) {
  const remoteAccess = useEnvironmentQuery(
    tailcatEnvironment.remoteAccess({ environmentId, input: {} }),
  );
  const state: TailcatRemoteAccessState | null = remoteAccess.data;
  const setRemoteAccessEnabled = useAtomCommand(tailcatEnvironment.setRemoteAccessEnabled, {
    reportFailure: false,
  });
  const createConnectionCode = useAtomCommand(tailcatEnvironment.createConnectionCode, {
    reportFailure: false,
  });
  const revokeTrustedPeer = useAtomCommand(tailcatEnvironment.revokeTrustedPeer, {
    reportFailure: false,
  });
  const renameTrustedPeer = useAtomCommand(tailcatEnvironment.renameTrustedPeer, {
    reportFailure: false,
  });
  const regenerateIdentity = useAtomCommand(tailcatEnvironment.regenerateIdentity, {
    reportFailure: false,
  });
  const [isToggling, setIsToggling] = useState(false);
  const [isCreatingCode, setIsCreatingCode] = useState(false);
  const [issuedCode, setIssuedCode] = useState<IssuedConnectionCode | null>(null);
  const [revokingPeerId, setRevokingPeerId] = useState<string | null>(null);
  const [isRegenerateDialogOpen, setIsRegenerateDialogOpen] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const { copyToClipboard } = useCopyToClipboard<{ title: string }>({
    onCopy: ({ title }) => {
      toastManager.add({ type: "success", title });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({ type: "error", title: "Could not copy", description: error.message }),
      );
    },
  });

  const runCommand = useCallback(
    async (
      execute: () => Promise<AtomCommandResult<unknown, unknown>>,
      failureTitle: string,
    ): Promise<boolean> => {
      setMutationError(null);
      const result = await execute();
      if (result._tag === "Success") return true;
      if (!isAtomCommandInterrupted(result)) {
        const message = formatTailcatConnectionError(
          squashAtomCommandFailure(result),
          failureTitle,
        );
        setMutationError(message);
        toastManager.add(
          stackedThreadToast({ type: "error", title: failureTitle, description: message }),
        );
      }
      return false;
    },
    [],
  );

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      setIsToggling(true);
      const changed = await runCommand(
        () => setRemoteAccessEnabled({ environmentId, input: { enabled } }),
        enabled ? "Could not enable Tailcat" : "Could not disable Tailcat",
      );
      if (changed && !enabled) setIssuedCode(null);
      setIsToggling(false);
    },
    [environmentId, runCommand, setRemoteAccessEnabled],
  );

  const handleCreateCode = useCallback(async () => {
    setIsCreatingCode(true);
    setMutationError(null);
    const result = await createConnectionCode({ environmentId, input: {} });
    setIsCreatingCode(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const message = formatTailcatConnectionError(
          squashAtomCommandFailure(result),
          "Could not create a connection code.",
        );
        setMutationError(message);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not create connection code",
            description: message,
          }),
        );
      }
      return;
    }
    setIssuedCode({
      result: result.value,
      lifetimeMinutes: connectionCodeLifetimeMinutes(result.value.expiresAt, Date.now()),
    });
  }, [createConnectionCode, environmentId]);

  const handleRename = useCallback(
    (peerId: string, label: string) =>
      runCommand(
        () => renameTrustedPeer({ environmentId, input: { peerId, label } }),
        "Could not rename the device",
      ),
    [environmentId, renameTrustedPeer, runCommand],
  );

  const handleRevoke = useCallback(
    async (peerId: string) => {
      setRevokingPeerId(peerId);
      const revoked = await runCommand(
        () => revokeTrustedPeer({ environmentId, input: { peerId } }),
        "Could not revoke the device",
      );
      setRevokingPeerId(null);
      if (revoked) {
        toastManager.add({
          type: "success",
          title: "Device revoked",
          description: "It can no longer reach this environment over Tailcat until it pairs again.",
        });
      }
    },
    [environmentId, revokeTrustedPeer, runCommand],
  );

  const handleRegenerate = useCallback(async () => {
    setIsRegenerating(true);
    const regenerated = await runCommand(
      () => regenerateIdentity({ environmentId, input: {} }),
      "Could not regenerate the Tailcat identity",
    );
    setIsRegenerating(false);
    if (regenerated) {
      setIssuedCode(null);
      setIsRegenerateDialogOpen(false);
      toastManager.add({
        type: "success",
        title: "Tailcat identity regenerated",
        description: "Share a fresh connection code with each device that should reconnect.",
      });
    }
  }, [environmentId, regenerateIdentity, runCommand]);

  const runtimeLabel = state ? tailcatRuntimeLabel(state.runtime) : null;
  const connectionCodeSetting = searchableSetting("tailcat-connection-code");
  const trustedDevicesSetting = searchableSetting("tailcat-trusted-devices");
  const canCreateCode =
    state !== null && state.enabled && state.status === "ready" && !isCreatingCode;
  const address =
    state?.address != null
      ? state.remotePort !== null
        ? `${state.address}:${state.remotePort}`
        : state.address
      : null;

  return (
    <>
      <SettingsRow
        {...searchableSetting("tailcat-remote-access")}
        description={
          state === null
            ? (remoteAccess.error ?? "Loading Tailcat state…")
            : state.enabled
              ? "Other devices reach this environment through a WireGuard tunnel at its Tailcat address, with relay fallback when a direct path is blocked."
              : "Let your other devices reach this environment through a WireGuard tunnel with relay fallback. No port forwarding or VPN account needed."
        }
        status={
          <span className="block text-muted-foreground/70">
            Running the server headless? Start it with{" "}
            <code className="font-mono text-foreground/80">t3 serve --tailcat</code>.
          </span>
        }
        control={
          <Switch
            aria-label="Enable remote access via Tailcat"
            checked={state?.enabled ?? false}
            disabled={
              state === null || isToggling || (!state.enabled && state.status === "unavailable")
            }
            onCheckedChange={(checked) => void handleToggle(checked)}
          />
        }
      >
        {state !== null ? (
          <div className="mt-3 space-y-4 rounded-xl border border-border/60 bg-muted/10 p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant={tailcatStatusBadgeVariant(state.status)} size="sm">
                {tailcatStatusLabel(state.status)}
              </Badge>
              {state.pairingOpen ? (
                <Badge variant="info" size="sm">
                  Pairing window open
                </Badge>
              ) : null}
              {runtimeLabel ? (
                <span className="text-muted-foreground">Runtime {runtimeLabel}</span>
              ) : null}
              {state.runtime !== null && !state.runtime.compatible ? (
                <Badge variant="warning" size="sm">
                  Incompatible · expected {state.runtime.pinnedVersion}
                </Badge>
              ) : null}
              {state.identityFingerprint ? (
                <span className="truncate font-mono text-muted-foreground">
                  identity {state.identityFingerprint}
                </span>
              ) : null}
            </div>
            {address !== null ? (
              <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                        {address}
                      </code>
                    }
                  />
                  <TooltipPopup side="top" className="max-w-80 break-all">
                    {address}
                  </TooltipPopup>
                </Tooltip>
                <Button
                  size="xs"
                  variant="ghost"
                  className="shrink-0"
                  onClick={() => copyToClipboard(address, { title: "Tailcat address copied" })}
                >
                  <CopyIcon aria-hidden />
                  Copy
                </Button>
              </div>
            ) : null}
            {state.lastError !== null ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                <p>{state.lastError.message}</p>
                <p className="mt-1 text-destructive/70">
                  {state.lastError.code} · {formatFederationTimestamp(state.lastError.at)}
                </p>
              </div>
            ) : null}
            {mutationError !== null ? (
              <p className="text-xs text-destructive">{mutationError}</p>
            ) : null}

            <section id={connectionCodeSetting.id} className="space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <h4 className="text-sm font-medium text-foreground">
                    {connectionCodeSetting.title}
                  </h4>
                  <p className="text-xs text-muted-foreground">
                    Paste it in the desktop app on another device under Add environment → Tailcat.
                    Each code works once.
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="default"
                  className="shrink-0"
                  disabled={!canCreateCode}
                  onClick={() => void handleCreateCode()}
                >
                  <PlusIcon className="size-3" />
                  {isCreatingCode ? "Creating…" : "Create connection code"}
                </Button>
              </div>
              {issuedCode !== null ? (
                <ConnectionCodeReveal issued={issuedCode} />
              ) : !state.enabled ? (
                <p className="text-[11px] text-muted-foreground/70">
                  Enable remote access to create codes.
                </p>
              ) : state.status !== "ready" ? (
                <p className="text-[11px] text-muted-foreground/70">
                  Codes can be created once the listener is ready.
                </p>
              ) : null}
            </section>

            <section id={trustedDevicesSetting.id} className="space-y-2">
              <div>
                <h4 className="text-sm font-medium text-foreground">
                  {trustedDevicesSetting.title}
                </h4>
                <p className="text-xs text-muted-foreground">
                  Devices that redeemed a connection code. Only these can reach the listener outside
                  a pairing window.
                </p>
              </div>
              {state.trustedPeers.length === 0 ? (
                <p className="text-xs text-muted-foreground/70">
                  No trusted devices yet. Create a connection code and redeem it on another device.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {state.trustedPeers.map((peer) => (
                    <TrustedPeerRow
                      key={peer.id}
                      peer={peer}
                      busy={revokingPeerId === peer.id}
                      onRename={handleRename}
                      onRevoke={(peerId) => void handleRevoke(peerId)}
                    />
                  ))}
                </div>
              )}
            </section>

            <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-3">
              <p className="text-[11px] text-muted-foreground/70">
                Updated {formatFederationTimestamp(state.updatedAt)}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    copyToClipboard(tailcatDiagnosticsJson(state), {
                      title: "Tailcat diagnostics copied",
                    })
                  }
                >
                  Copy diagnostics
                </Button>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button size="icon-xs" variant="ghost" aria-label="More Tailcat actions" />
                    }
                  >
                    <EllipsisIcon aria-hidden />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem
                      variant="destructive"
                      disabled={state.identityFingerprint === null}
                      onClick={() => setIsRegenerateDialogOpen(true)}
                    >
                      Regenerate identity…
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </div>
            </div>
          </div>
        ) : null}
      </SettingsRow>
      <AlertDialog
        open={isRegenerateDialogOpen}
        onOpenChange={(open) => {
          if (isRegenerating) return;
          setIsRegenerateDialogOpen(open);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate Tailcat identity?</AlertDialogTitle>
            <AlertDialogDescription>
              This environment gets a new Tailcat address. Connection codes you already shared stop
              working, and every device that saved this environment over Tailcat has to pair again
              with a fresh code.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={isRegenerating}
              render={<Button variant="outline" disabled={isRegenerating} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={isRegenerating}
              onClick={() => void handleRegenerate()}
            >
              {isRegenerating ? "Regenerating…" : "Regenerate identity"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
});
