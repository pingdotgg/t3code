import type { TailcatConnectionProfile } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, TailcatConnectionDiagnostics } from "@t3tools/contracts";
import { memo, useCallback, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  desktopTailcatDiagnosticsAtom,
  isDesktopTailcatAvailable,
  probeDesktopTailcatConnectionPath,
  restartDesktopTailcatEnvironment,
} from "~/state/desktopTailcat";
import { useEnvironmentQuery } from "~/state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { TailcatConnectForm } from "./TailcatConnectForm";
import {
  formatTailcatConnectionError,
  tailcatForwardStatusLabel,
  tailcatNodeKeyFingerprint,
  tailcatPathKindLabel,
  tailcatPathLabel,
  tailcatRuntimeLabel,
} from "./TailcatRemoteAccess.logic";

/** Subtitle for a saved Tailcat row: the transport plus the measured path once a probe ran. */
export function useTailcatEnvironmentSubtitle(connectionId: string | null): string | null {
  const diagnostics = useEnvironmentQuery(
    connectionId !== null && isDesktopTailcatAvailable()
      ? desktopTailcatDiagnosticsAtom(connectionId)
      : null,
  );
  if (connectionId === null) return null;
  return tailcatPathLabel(diagnostics.data?.path ?? null);
}

const formatMeasuredAt = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(parsed);
};

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all text-right font-mono text-foreground">{value}</span>
    </div>
  );
}

const forwardStatusBadgeVariant = (status: TailcatConnectionDiagnostics["status"]) => {
  switch (status) {
    case "ready":
      return "success";
    case "starting":
      return "warning";
    case "failed":
      return "error";
    case "stopped":
      return "outline";
  }
};

type TailcatEnvironmentDetailsDialogProps = {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly profile: TailcatConnectionProfile;
  readonly removing: boolean;
  readonly onRemove: (environmentId: EnvironmentId) => void;
};

/**
 * Transport details for one saved Tailcat environment: where the forwarder
 * listens, how packets travel, what it printed, and the repairs available
 * (restart the tunnel, re-pair with a fresh code, forget it).
 */
export const TailcatEnvironmentDetailsDialog = memo(function TailcatEnvironmentDetailsDialog({
  environmentId,
  environmentLabel,
  profile,
  removing,
  onRemove,
}: TailcatEnvironmentDetailsDialogProps) {
  const [open, setOpen] = useState(false);
  const [isProbing, setIsProbing] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const desktopAvailable = isDesktopTailcatAvailable();
  const diagnosticsQuery = useEnvironmentQuery(
    open && desktopAvailable ? desktopTailcatDiagnosticsAtom(profile.connectionId) : null,
  );
  const diagnostics = diagnosticsQuery.data ?? null;

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

  const runBridgeAction = useCallback(
    async (
      action: () => Promise<unknown>,
      setBusy: (busy: boolean) => void,
      failureTitle: string,
    ) => {
      setBusy(true);
      setActionError(null);
      try {
        await action();
      } catch (cause) {
        const message = formatTailcatConnectionError(cause, failureTitle);
        setActionError(message);
        toastManager.add(
          stackedThreadToast({ type: "error", title: failureTitle, description: message }),
        );
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const handleProbe = useCallback(
    () =>
      runBridgeAction(
        () => probeDesktopTailcatConnectionPath(profile.connectionId),
        setIsProbing,
        "Could not probe the Tailcat path",
      ),
    [profile.connectionId, runBridgeAction],
  );

  const handleRestart = useCallback(
    () =>
      runBridgeAction(
        async () => {
          await restartDesktopTailcatEnvironment(profile.connectionId);
          toastManager.add({
            type: "success",
            title: "Tunnel restarted",
            description: `${environmentLabel} is reconnecting through Tailcat.`,
          });
        },
        setIsRestarting,
        "Could not restart the Tailcat tunnel",
      ),
    [environmentLabel, profile.connectionId, runBridgeAction],
  );

  const handleCopyDiagnostics = useCallback(() => {
    copyToClipboard(
      JSON.stringify(
        {
          environmentId,
          label: environmentLabel,
          connectionId: profile.connectionId,
          address: profile.address,
          remotePort: profile.remotePort,
          diagnostics,
        },
        null,
        2,
      ),
      { title: "Diagnostics copied" },
    );
  }, [copyToClipboard, diagnostics, environmentId, environmentLabel, profile]);

  const hasRecentOutput = diagnostics !== null && diagnostics.recentOutput.length > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="xs" variant="outline" />}>Details</DialogTrigger>
      <DialogPopup className="max-h-[85dvh] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{environmentLabel}</DialogTitle>
          <DialogDescription>
            Reached through a Tailcat tunnel the desktop app runs on this device.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <section className="space-y-2">
            <DetailRow label="Tailcat address" value={`${profile.address}:${profile.remotePort}`} />
            <DetailRow label="Environment id" value={environmentId} />
            {!desktopAvailable ? (
              <p className="text-xs text-muted-foreground">
                Tunnel diagnostics are available in the desktop app that runs this tunnel.
              </p>
            ) : diagnosticsQuery.error ? (
              <p className="text-xs text-destructive">{diagnosticsQuery.error}</p>
            ) : diagnostics === null ? (
              <p className="text-xs text-muted-foreground">
                {diagnosticsQuery.isPending
                  ? "Loading tunnel diagnostics…"
                  : "No tunnel is running for this environment right now. Connect it to start one."}
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">Forwarder</span>
                  <span className="flex items-center gap-2">
                    <Badge variant={forwardStatusBadgeVariant(diagnostics.status)} size="sm">
                      {tailcatForwardStatusLabel(diagnostics.status)}
                    </Badge>
                    {diagnostics.pid !== null ? (
                      <span className="font-mono text-muted-foreground">pid {diagnostics.pid}</span>
                    ) : null}
                    <span className="text-muted-foreground">
                      {diagnostics.restartCount === 1
                        ? "1 restart"
                        : `${diagnostics.restartCount} restarts`}
                    </span>
                  </span>
                </div>
                <DetailRow label="Local endpoint" value={diagnostics.localEndpoint ?? "—"} />
                <DetailRow
                  label="Runtime"
                  value={tailcatRuntimeLabel(diagnostics.runtime) ?? "unknown"}
                />
                <DetailRow
                  label="This device's key"
                  value={
                    diagnostics.clientNodeKey
                      ? `…${tailcatNodeKeyFingerprint(diagnostics.clientNodeKey)}`
                      : "—"
                  }
                />
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">Path</span>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-foreground">
                      {diagnostics.path === null
                        ? "Not measured yet"
                        : `${tailcatPathKindLabel(diagnostics.path)}${
                            diagnostics.path.latencyMs !== null
                              ? ` · ${Math.round(diagnostics.path.latencyMs)} ms`
                              : ""
                          } · ${formatMeasuredAt(diagnostics.path.measuredAt)}`}
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={isProbing || diagnostics.status !== "ready"}
                      onClick={() => void handleProbe()}
                    >
                      {isProbing ? "Probing…" : "Probe"}
                    </Button>
                  </span>
                </div>
                {diagnostics.lastError ? (
                  <p className="text-xs text-destructive">
                    {diagnostics.lastError.message}
                    <span className="text-destructive/70">
                      {" "}
                      · {formatMeasuredAt(diagnostics.lastError.at)}
                    </span>
                  </p>
                ) : null}
                {hasRecentOutput ? (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Recent output</p>
                    <pre className="max-h-40 overflow-auto rounded-lg border border-border/60 bg-muted/30 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-foreground/85">
                      {diagnostics.recentOutput.join("\n")}
                    </pre>
                  </div>
                ) : null}
              </>
            )}
            {actionError ? <p className="text-xs text-destructive">{actionError}</p> : null}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                size="xs"
                variant="outline"
                disabled={!desktopAvailable || isRestarting || diagnostics === null}
                onClick={() => void handleRestart()}
              >
                {isRestarting ? "Restarting…" : "Restart tunnel"}
              </Button>
              <Button size="xs" variant="outline" onClick={handleCopyDiagnostics}>
                Copy diagnostics
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={!desktopAvailable || diagnosticsQuery.isPending}
                onClick={diagnosticsQuery.refresh}
              >
                Refresh
              </Button>
            </div>
          </section>
          <section className="space-y-2 border-t border-border/50 pt-4">
            <div>
              <h3 className="text-sm font-medium text-foreground">Re-pair</h3>
              <p className="text-xs text-muted-foreground">
                Paste a fresh connection code from {environmentLabel} to replace this device's
                credential. The environment keeps its id and history here.
              </p>
            </div>
            <TailcatConnectForm
              mode="repair"
              expectedEnvironmentId={environmentId}
              onConnected={() => setOpen(false)}
            />
          </section>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="destructive-outline"
            disabled={removing}
            onClick={() => {
              onRemove(environmentId);
              setOpen(false);
            }}
          >
            {removing ? "Forgetting…" : "Forget environment"}
          </Button>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});
