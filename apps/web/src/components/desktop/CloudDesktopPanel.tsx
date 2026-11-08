import { randomUUID } from "../../lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";
import {
  ManagedCloudSandboxResourceId,
  type EnvironmentId,
  type ManagedCloudSandboxControlOperation,
  type SandboxRecording,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Button } from "../ui/button";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  cloudSandboxDesktopAtom,
  cloudSandboxStatusAtom,
  cloudSandboxRecordingAtom,
  cloudSandboxOperation,
  downloadRecording,
} from "~/connection/cloudSandbox";

export function CloudDesktopPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [viewMode, setViewMode] = useState<"desktop" | "browser">("desktop");
  const [scale, setScale] = useState<"fit" | "native">("fit");
  const container = useRef<HTMLDivElement>(null);
  const statusQuery = useEnvironmentQuery(cloudSandboxStatusAtom(environmentId));
  const context = statusQuery.data ?? null;
  const status = context !== null ? context.sandbox : null;
  const query = useEnvironmentQuery(cloudSandboxDesktopAtom(environmentId)(viewMode));
  const desktopUrl = query.data?.desktopUrl ?? null;
  const execute = useAtomCommand(cloudSandboxOperation, { reportFailure: false });
  const download = useAtomCommand(downloadRecording, { reportFailure: false });
  const canControl = useAtomValue(
    cloudSandboxOperation.permissionAtom(context?.controllerEnvironmentId ?? environmentId),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const recoveredRecording = useEnvironmentQuery(cloudSandboxRecordingAtom(environmentId));
  const [latestRecording, setRecording] = useState<SandboxRecording | null>(null);
  const recording = latestRecording ?? recoveredRecording.data ?? null;
  const [resizeSize, setResizeSize] = useState("small");
  const control = async (operation: ManagedCloudSandboxControlOperation) => {
    if (context === null || !canControl) return;
    setBusy(true);
    setError(null);
    const result = await execute({
      environmentId: context.controllerEnvironmentId,
      input: { resourceId: context.resourceId, operation },
    });
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    else {
      if (result.value._tag === "recording") setRecording(result.value.recording);
      statusQuery.refresh();
      query.refresh();
    }
    setBusy(false);
  };
  if (context === null)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {statusQuery.isPending
          ? "Loading cloud sandbox…"
          : "Sandbox status is unavailable right now."}
      </p>
    );
  return (
    <div ref={container} className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b p-2">
        <span className="text-xs">{status ? `${status.name} · ${status.state}` : "Loading"}</span>
        {context.usage?.listRateUsdPerHour != null ? (
          <span className="text-xs">${context.usage?.listRateUsdPerHour}/h estimate</span>
        ) : null}
        {status?.autoStopDeadline ? (
          <span className="text-xs">
            Auto-stop {new Date(status.autoStopDeadline).toLocaleTimeString()}
          </span>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canControl}
          onClick={() => {
            query.refresh();
            statusQuery.refresh();
          }}
        >
          Refresh
        </Button>
        {status?.state === "stopped" ? (
          <Button
            size="sm"
            disabled={busy || !canControl}
            onClick={() => {
              void control({ _tag: "resume" });
            }}
          >
            Resume
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !canControl}
            onClick={() => {
              void control({ _tag: "stop" });
            }}
          >
            Stop sandbox
          </Button>
        )}
        {context.capabilities.browserStreaming ? (
          <>
            <Button
              variant={viewMode === "desktop" ? "secondary" : "outline"}
              size="sm"
              disabled={busy || !canControl}
              onClick={() => setViewMode("desktop")}
            >
              Desktop
            </Button>
            <Button
              variant={viewMode === "browser" ? "secondary" : "outline"}
              size="sm"
              disabled={busy || !canControl}
              onClick={() => setViewMode("browser")}
            >
              Browser
            </Button>
          </>
        ) : null}
        <select
          aria-label="Desktop scale"
          value={scale}
          onChange={(event) => {
            if (event.target.value === "fit" || event.target.value === "native")
              setScale(event.target.value);
          }}
        >
          <option value="fit">Fit to window</option>
          <option value="native">1920 × 1080</option>
        </select>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void (document.fullscreenElement
              ? document.exitFullscreen()
              : container.current?.requestFullscreen());
          }}
        >
          Fullscreen
        </Button>
        {context.capabilities.autoStopKeepalive ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !canControl}
            onClick={() => {
              void control({ _tag: "extend", hours: 1 });
            }}
          >
            Keep alive for 1 hour
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={() => query.refresh()}>
          Reconnect viewer
        </Button>
        {context.capabilities.recording ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !canControl}
              onClick={() =>
                void control(
                  recording?.state === "recording"
                    ? {
                        _tag: "recordingStop",
                        recordingId: ManagedCloudSandboxResourceId.make(recording.recordingId),
                      }
                    : {
                        _tag: "recordingStart",
                        recordingId: ManagedCloudSandboxResourceId.make(randomUUID()),
                      },
                )
              }
            >
              {recording?.state === "recording" ? "Stop recording" : "Record MP4"}
            </Button>
            {recording ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !canControl}
                onClick={() =>
                  void control({
                    _tag: "recordingStatus",
                    recordingId: ManagedCloudSandboxResourceId.make(recording.recordingId),
                  })
                }
              >
                Recording: {recording.state}
              </Button>
            ) : null}
            {recording?.state === "completed" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void download({
                    environmentId,
                    recordingId: ManagedCloudSandboxResourceId.make(recording.recordingId),
                  }).then((result) => {
                    if (result._tag === "Failure") {
                      setError(String(squashAtomCommandFailure(result)));
                      return;
                    }
                    const url = URL.createObjectURL(
                      new Blob([new Uint8Array(result.value)], { type: "video/mp4" }),
                    );
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = `${recording.recordingId}.mp4`;
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  });
                }}
              >
                Download MP4
              </Button>
            ) : null}
          </>
        ) : null}
        {context.capabilities.resizeMode && context.capabilities.resizeMode !== "none" ? (
          <>
            <select
              aria-label="Resize machine"
              value={resizeSize}
              onChange={(event) => setResizeSize(event.target.value)}
            >
              {["small", "default", "large", "xlarge"].map((size) => (
                <option key={size}>{size}</option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !canControl}
              onClick={() => {
                if (
                  context.capabilities.resizeMode === "restart" &&
                  !window.confirm(
                    "Resize requires stopping and restarting this sandbox. Running work will be interrupted. Continue?",
                  )
                )
                  return;
                void control({ _tag: "resize", size: resizeSize });
              }}
            >
              Resize sandbox
            </Button>
          </>
        ) : null}
      </div>
      {error || query.error || recoveredRecording.error ? (
        <p role="alert" className="p-3 text-sm">
          {error ?? query.error ?? recoveredRecording.error}
        </p>
      ) : null}
      {desktopUrl && status?.state === "ready" && context.capabilities.desktopStreaming ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <iframe
            title="Cloud desktop"
            src={desktopUrl}
            className="border-0"
            style={
              scale === "native" ? { width: 1920, height: 1080 } : { width: "100%", height: "100%" }
            }
            allow="clipboard-read; clipboard-write; fullscreen"
            // oxlint-disable-next-line react/iframe-missing-sandbox -- the cross-origin provider viewer needs its origin for WebRTC and clipboard requests
            sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads"
            allowFullScreen
          />
        </div>
      ) : (
        <p className="p-4 text-sm text-muted-foreground">
          {busy || query.isPending
            ? "Loading cloud desktop…"
            : status?.state === "stopped"
              ? "Resume the sandbox to open its desktop."
              : "Desktop streaming is unavailable."}
        </p>
      )}
    </div>
  );
}
