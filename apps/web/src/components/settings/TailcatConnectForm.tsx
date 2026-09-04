import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { ClipboardPasteIcon, RadioTowerIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { readTextFromClipboard } from "../../hooks/useCopyToClipboard";
import { formatExpiresInLabel } from "../../timestampFormat";
import { connectTailcatEnvironment as connectTailcatEnvironmentAtom } from "~/connection/onboarding";
import { isDesktopTailcatAvailable } from "~/state/desktopTailcat";
import { tailcatProvisioningProgressAtom } from "~/state/tailcatProvisioning";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useRelativeTimeTick } from "./settingsLayout";
import {
  describeTailcatConnectionCode,
  formatTailcatConnectionError,
} from "./TailcatRemoteAccess.logic";

const TAILCAT_DESKTOP_REQUIRED_MESSAGE =
  "Desktop app required. The T3 Code desktop app runs the Tailcat tunnel for this device.";

type TailcatConnectFormProps = {
  /** "add" saves a new environment; "repair" refreshes an existing one from a fresh code. */
  readonly mode: "add" | "repair";
  /** In repair mode, the code must name this environment. */
  readonly expectedEnvironmentId?: EnvironmentId;
  readonly onConnected: (environmentId: EnvironmentId) => void;
};

/**
 * Paste a `t3c://tailcat/...` connection code, see which machine it names,
 * and connect. The tunnel and pairing run in the desktop app; progress comes
 * from the gateway's provisioning state, so the labels track real steps.
 */
export const TailcatConnectForm = memo(function TailcatConnectForm({
  mode,
  expectedEnvironmentId,
  onConnected,
}: TailcatConnectFormProps) {
  const [code, setCode] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nowMs = useRelativeTimeTick(1_000);
  const provisioning = useAtomValue(tailcatProvisioningProgressAtom);
  const connectTailcatEnvironment = useAtomCommand(connectTailcatEnvironmentAtom, {
    reportFailure: false,
  });
  const desktopAvailable = isDesktopTailcatAvailable();
  const canPasteFromClipboard =
    typeof navigator !== "undefined" && navigator.clipboard?.readText !== undefined;

  const preview = useMemo(() => describeTailcatConnectionCode(code, nowMs), [code, nowMs]);
  const environmentMismatch =
    preview.kind === "valid" &&
    expectedEnvironmentId !== undefined &&
    preview.payload.environmentId !== undefined &&
    preview.payload.environmentId !== expectedEnvironmentId;
  const canConnect =
    desktopAvailable &&
    !isConnecting &&
    preview.kind === "valid" &&
    !preview.expired &&
    preview.hasPairingToken &&
    !environmentMismatch;

  const handlePaste = useCallback(async () => {
    try {
      const text = await readTextFromClipboard("connection code");
      setCode(text.trim());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the clipboard.");
    }
  }, []);

  const handleConnect = useCallback(async () => {
    if (!canConnect) return;
    setIsConnecting(true);
    setError(null);
    const result = await connectTailcatEnvironment({ code: code.trim() });
    setIsConnecting(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const message = formatTailcatConnectionError(
        squashAtomCommandFailure(result),
        "Could not connect over Tailcat.",
      );
      setError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: mode === "repair" ? "Could not re-pair" : "Could not connect over Tailcat",
          description: message,
        }),
      );
      return;
    }
    setCode("");
    toastManager.add({
      type: "success",
      title: mode === "repair" ? "Environment re-paired" : "Environment connected",
      description:
        mode === "repair"
          ? "The saved environment has a fresh Tailcat credential."
          : "The environment is saved and reconnects through Tailcat on app startup.",
    });
    onConnected(result.value);
  }, [canConnect, code, connectTailcatEnvironment, mode, onConnected]);

  const connectLabel = isConnecting
    ? provisioning?.phase === "pairing"
      ? "Pairing…"
      : "Starting tunnel…"
    : mode === "repair"
      ? "Re-pair"
      : "Connect";

  return (
    <div className="space-y-3">
      <div className="block">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <label
            htmlFor={`tailcat-connection-code-${mode}`}
            className="text-xs font-medium text-foreground"
          >
            Connection code
          </label>
          {canPasteFromClipboard ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={!desktopAvailable || isConnecting}
              onClick={() => void handlePaste()}
            >
              <ClipboardPasteIcon aria-hidden />
              Paste
            </Button>
          ) : null}
        </div>
        <Textarea
          id={`tailcat-connection-code-${mode}`}
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            setError(null);
          }}
          placeholder="t3c://tailcat/…"
          rows={3}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={!desktopAvailable || isConnecting}
          className="font-mono text-xs leading-relaxed break-all"
        />
      </div>
      {!desktopAvailable ? (
        <p className="text-xs text-muted-foreground">{TAILCAT_DESKTOP_REQUIRED_MESSAGE}</p>
      ) : preview.kind === "valid" ? (
        <div className="space-y-1 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs">
          <p className="flex min-w-0 items-center gap-1.5 text-foreground">
            <RadioTowerIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-medium">
              {preview.payload.name ?? preview.payload.environmentId ?? "Tailcat environment"}
            </span>
            {preview.payload.serverVersion ? (
              <span className="text-muted-foreground">· t3@{preview.payload.serverVersion}</span>
            ) : null}
          </p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {preview.payload.address}:{preview.payload.port}
          </p>
          {environmentMismatch ? (
            <p className="text-destructive">
              This code names a different environment. Ask the same machine for a fresh code.
            </p>
          ) : preview.expired ? (
            <p className="text-destructive">
              This code has expired. Create a fresh one on the other machine.
            </p>
          ) : !preview.hasPairingToken ? (
            <p className="text-destructive">
              This code has no pairing credential. Ask the other machine for a fresh code.
            </p>
          ) : preview.payload.expiresAt ? (
            <p className="text-muted-foreground">
              {formatExpiresInLabel(preview.payload.expiresAt, nowMs)} · single use
            </p>
          ) : null}
        </div>
      ) : preview.kind === "invalid" || preview.kind === "peer-code" ? (
        <p className="text-xs text-destructive">{preview.message}</p>
      ) : null}
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      <Button
        variant="outline"
        className="w-full"
        disabled={!canConnect}
        onClick={() => void handleConnect()}
      >
        <RadioTowerIcon className="size-3.5" />
        {connectLabel}
      </Button>
    </div>
  );
});
