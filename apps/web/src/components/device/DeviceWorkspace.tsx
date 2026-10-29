import type { DeviceHostSummary, DeviceSummary, EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import {
  captureDeviceScreenshot,
  DeviceScreenshotError,
} from "@t3tools/client-runtime/device/screenshot";
import { refreshDeviceHubAccess, useDeviceHubAccess } from "~/state/device";
import { DeviceControlsRail } from "./DeviceControlsRail";
import { DeviceStreamView } from "./DeviceStreamView";
import { DeviceToolsPanel } from "./DeviceToolsPanel";
import { useDeviceControls } from "./useDeviceControls";

const DOWNLOAD_URL_LIFETIME_MS = 60_000;

export function DeviceWorkspace(props: {
  environmentId: EnvironmentId;
  device: DeviceSummary;
  hostLabel: string;
  hostKind: DeviceHostSummary["kind"] | undefined;
  hostDiagnostics: { readonly label: string; readonly detail: string } | undefined;
  visible: boolean;
  onFloat: () => void;
  onClose: () => void;
  onPowerOff: () => void;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [axOverlay, setAxOverlay] = useState(false);
  const [screenshotPending, setScreenshotPending] = useState(false);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  // A capture always finishes, even if the panel hides or closes meanwhile; the user asked for it.
  const capturing = useRef(false);
  const access = useDeviceHubAccess(props.environmentId, props.device.hostId);
  // Settings and tools run commands on the device's own machine, which EAS and Simlock do not expose.
  const runsHostCommands = props.hostKind === "local" || props.hostKind === "ssh";
  const controls = useDeviceControls({
    ...props,
    access,
    visible: props.visible && runsHostCommands,
  });
  const saveScreenshot = () => {
    if (!access || capturing.current || !props.visible) return;
    capturing.current = true;
    setScreenshotPending(true);
    setScreenshotError(null);
    return captureDeviceScreenshot(
      { access, platform: props.device.platform, deviceId: props.device.id },
      // Never aborted: see `capturing` above.
      new AbortController().signal,
    )
      .then((image) => {
        const url = URL.createObjectURL(image);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${props.device.name.replace(/[^a-z0-9-]/gi, "-")}-${Date.now()}.png`;
        document.body.append(link);
        link.click();
        link.remove();
        // The browser reads the blob after the click returns.
        window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DeviceScreenshotError && cause.status === 401)
          refreshDeviceHubAccess(props.environmentId);
        setScreenshotError(
          cause instanceof Error ? cause.message : "Screenshot capture failed. Try again.",
        );
      })
      .finally(() => {
        capturing.current = false;
        setScreenshotPending(false);
      });
  };
  return (
    <>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {screenshotError || (controls.error && !toolsOpen) ? (
          <p role="alert" className="px-3 py-2 text-xs text-destructive">
            {screenshotError ?? controls.error}
          </p>
        ) : null}
        <div className="min-h-0 flex-1">
          <DeviceStreamView
            environmentId={props.environmentId}
            platform={props.device.platform}
            deviceName={props.device.name}
            deviceDescription={`${props.hostLabel} · ${props.device.version}`}
            deviceId={props.device.id}
            hostId={props.device.hostId}
            visible={props.visible}
            serveSimOnly={props.hostKind === "simlock"}
            axOverlay={axOverlay}
            allowPhoneView
            renderControls={(view) => (
              <DeviceControlsRail
                platform={props.device.platform}
                hostKind={props.hostKind}
                handle={view.handle}
                view={view}
                controls={controls}
                screenshotPending={screenshotPending}
                onScreenshot={() => void saveScreenshot()}
                toolsOpen={toolsOpen}
                onTools={() => setToolsOpen(!toolsOpen)}
                onFloat={props.onFloat}
                onClose={props.onClose}
                onPowerOff={props.onPowerOff}
              />
            )}
          />
        </div>
      </div>
      {toolsOpen ? (
        <DeviceToolsPanel
          device={props.device}
          controls={controls}
          hostDiagnostics={props.hostDiagnostics}
          access={access}
          axOverlay={axOverlay}
          onAxOverlayChange={setAxOverlay}
          onClose={() => setToolsOpen(false)}
          className="absolute inset-y-0 right-0 z-10 w-full max-w-72 border-l shadow-lg @[700px]:static @[700px]:w-72 @[700px]:shrink-0 @[700px]:shadow-none"
        />
      ) : null}
    </>
  );
}
