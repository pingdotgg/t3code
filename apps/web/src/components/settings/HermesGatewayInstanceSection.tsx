"use client";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  type HermesGatewayConnectionState,
  type HermesGatewayEnrollmentResult,
  type HermesGatewayInstanceStatus,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { CheckIcon, CopyIcon, LoaderIcon, RefreshCwIcon, UnplugIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import {
  defaultHermesConnectorUrl,
  formatHermesLastConnected,
  hermesGatewayStatusLabel,
  messageFromUnknownError,
  shouldApplyHermesConnectorStatusUrl,
} from "./HermesGatewayInstanceSection.logic";

const badgeVariantByStatus: Record<
  HermesGatewayConnectionState,
  "success" | "warning" | "error" | "secondary"
> = {
  connected: "success",
  connecting: "warning",
  offline: "secondary",
  "upgrade-required": "warning",
  revoked: "error",
};

function browserDefaultConnectorUrl() {
  if (typeof window === "undefined") return "http://localhost/api/hermes-gateway/ws";
  return defaultHermesConnectorUrl(window.location.origin);
}

export function HermesGatewayInstanceSection(props: {
  readonly instanceId: ProviderInstanceId;
  readonly nickname: string;
}) {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const getStatus = useAtomCommand(serverEnvironment.hermesGatewayGetInstanceStatus, {
    reportFailure: false,
  });
  const createEnrollment = useAtomCommand(serverEnvironment.hermesGatewayCreateEnrollment, {
    reportFailure: false,
  });
  const revokeInstance = useAtomCommand(serverEnvironment.hermesGatewayRevokeInstance, {
    reportFailure: false,
  });
  const [connectorUrl, setConnectorUrl] = useState(browserDefaultConnectorUrl);
  const [status, setStatus] = useState<HermesGatewayInstanceStatus | null>(null);
  const [enrollment, setEnrollment] = useState<HermesGatewayEnrollmentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"status" | "enroll" | "revoke" | null>(null);
  const connectorUrlHasLocalEditsRef = useRef(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "Hermes enrollment command",
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Hermes command copied",
        description: "Run it in the terminal where Hermes is installed.",
      });
    },
  });

  const refreshStatus = useCallback(
    async (quiet = false) => {
      if (environmentId === null) return;
      if (!quiet) setPendingAction("status");
      const result = await getStatus({
        environmentId,
        input: { instanceId: props.instanceId },
      });
      if (result._tag === "Success") {
        setStatus(result.value);
        if (shouldApplyHermesConnectorStatusUrl(connectorUrlHasLocalEditsRef.current)) {
          setConnectorUrl(result.value.connectorUrl);
        }
        setError(null);
      } else if (!quiet) {
        setError(messageFromUnknownError(squashAtomCommandFailure(result)));
      }
      if (!quiet) setPendingAction(null);
    },
    [environmentId, getStatus, props.instanceId],
  );

  useEffect(() => {
    void refreshStatus();
    const interval = window.setInterval(() => void refreshStatus(true), 5_000);
    return () => window.clearInterval(interval);
  }, [refreshStatus]);

  const handleCreateEnrollment = async () => {
    if (environmentId === null) {
      setError("Connect this browser to a T3 server before pairing Hermes.");
      return;
    }
    setPendingAction("enroll");
    setError(null);
    const result = await createEnrollment({
      environmentId,
      input: {
        instanceId: props.instanceId,
        nickname: props.nickname,
        connectorUrl,
      },
    });
    if (result._tag === "Success") {
      connectorUrlHasLocalEditsRef.current = false;
      setConnectorUrl(result.value.connectorUrl);
      setEnrollment(result.value);
      setStatus((current) =>
        current
          ? { ...current, connectorUrl: result.value.connectorUrl, status: "offline" }
          : current,
      );
    } else {
      setError(messageFromUnknownError(squashAtomCommandFailure(result)));
    }
    setPendingAction(null);
  };

  const handleRevoke = async () => {
    if (environmentId === null) return;
    setPendingAction("revoke");
    setError(null);
    const result = await revokeInstance({
      environmentId,
      input: { instanceId: props.instanceId },
    });
    if (result._tag === "Success") {
      setStatus(result.value);
      setEnrollment(null);
    } else {
      setError(messageFromUnknownError(squashAtomCommandFailure(result)));
    }
    setPendingAction(null);
  };

  const connectionState = status?.status ?? "offline";
  const isBusy = pendingAction !== null;

  return (
    <section className="grid gap-4 rounded-lg border border-border/70 bg-muted/15 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-foreground">Hermes gateway</p>
          <p className="text-xs text-muted-foreground">
            Pair an already-running Hermes process over any reachable network.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge variant={badgeVariantByStatus[connectionState]} size="sm">
            {hermesGatewayStatusLabel(connectionState)}
          </Badge>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={isBusy || environmentId === null}
            onClick={() => void refreshStatus()}
            aria-label="Refresh Hermes gateway status"
          >
            <RefreshCwIcon className={pendingAction === "status" ? "animate-spin" : undefined} />
          </Button>
        </div>
      </div>

      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Connector URL</span>
        <Input
          value={connectorUrl}
          onChange={(event) => {
            connectorUrlHasLocalEditsRef.current = true;
            setConnectorUrl(event.target.value);
          }}
          placeholder="wss://t3.example.com/api/hermes-gateway/ws"
          spellCheck={false}
          disabled={connectionState === "revoked"}
        />
        <span className="text-[11px] text-muted-foreground">
          Defaults to this browser&apos;s origin. Tailscale URLs work without special handling.
        </span>
      </label>

      {status ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Last connected</dt>
            <dd className="text-foreground">{formatHermesLastConnected(status.lastConnectedAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Active sessions</dt>
            <dd className="text-foreground">{status.activeSessionCount}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Protocol</dt>
            <dd className="text-foreground">{status.protocolVersion ?? "Unknown"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Plugin</dt>
            <dd className="text-foreground">{status.pluginVersion ?? "Unknown"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Hermes</dt>
            <dd className="text-foreground">{status.hermesVersion ?? "Unknown"}</dd>
          </div>
        </dl>
      ) : null}

      {enrollment ? (
        <div className="grid gap-2 rounded-md border border-border/70 bg-background/80 p-2.5">
          <div>
            <p className="text-xs font-medium text-foreground">One-time enrollment command</p>
            <p className="text-[11px] text-muted-foreground">
              Expires {formatHermesLastConnected(enrollment.expiresAt)}. The long-lived credential
              is issued directly to the plugin and is never shown here.
            </p>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-muted px-2 py-1.5 text-[11px]">
              {enrollment.command}
            </code>
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              onClick={() => copyToClipboard(enrollment.command, undefined)}
              aria-label="Copy Hermes enrollment command"
            >
              {isCopied ? <CheckIcon /> : <CopyIcon />}
            </Button>
          </div>
        </div>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex flex-wrap gap-2">
        {connectionState !== "revoked" ? (
          <Button
            type="button"
            size="sm"
            variant={enrollment ? "outline" : "default"}
            disabled={isBusy || connectorUrl.trim().length === 0 || environmentId === null}
            onClick={() => void handleCreateEnrollment()}
          >
            {pendingAction === "enroll" ? <LoaderIcon className="animate-spin" /> : null}
            {enrollment ? "Retry enrollment" : "Create enrollment"}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="destructive-outline"
          disabled={isBusy || connectionState === "revoked" || environmentId === null}
          onClick={() => void handleRevoke()}
        >
          {pendingAction === "revoke" ? <LoaderIcon className="animate-spin" /> : <UnplugIcon />}
          Revoke
        </Button>
      </div>
    </section>
  );
}
