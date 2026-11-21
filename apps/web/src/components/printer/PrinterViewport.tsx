import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { PrinterSnapshot } from "@t3tools/contracts";
import { useGT } from "gt-react";
import {
  Camera,
  CameraOff,
  Download,
  Layers,
  Lightbulb,
  Pause,
  Play,
  RefreshCw,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useNowSecond } from "~/hooks/useNowSecond";
import { buildPrinterMediaUrl } from "~/state/printer";
import { formatAgeLabel } from "./printerFormat";

export type PrinterViewportMode = "camera" | "cover" | "pick";

interface PrinterViewportProps {
  readonly printer: PrinterSnapshot;
  readonly mediaAccess: DeviceHubAccess | null;
  readonly visible: boolean;
  readonly viewMode: PrinterViewportMode;
  readonly onViewModeChange: (mode: PrinterViewportMode) => void;
  readonly onToggleLight?: (() => void) | undefined;
  readonly onMediaError?: (() => void) | undefined;
  readonly lightPending?: boolean;
  readonly canControl?: boolean;
}

export function PrinterViewport({
  printer,
  mediaAccess,
  visible,
  viewMode,
  onViewModeChange,
  onToggleLight,
  onMediaError,
  lightPending = false,
  canControl = false,
}: PrinterViewportProps) {
  const gt = useGT();
  const nowMs = useNowSecond();
  const [streamPaused, setStreamPaused] = useState(false);
  const [frameTick, setFrameTick] = useState(0);
  const [erroredUrl, setErroredUrl] = useState<string | null>(null);

  const effectiveMode: PrinterViewportMode =
    viewMode === "cover" && !printer.media.hasCoverImage
      ? "camera"
      : viewMode === "pick" && !printer.media.hasPickImage
        ? "camera"
        : viewMode;

  const shouldPollCamera =
    visible &&
    !streamPaused &&
    effectiveMode === "camera" &&
    printer.media.hasCamera &&
    printer.online;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Advances the camera snapshot cache-buster on a 2s interval only while the viewport is visible and live.
  useEffect(() => {
    if (!shouldPollCamera) return;
    const interval = window.setInterval(() => {
      setFrameTick((current) => current + 1);
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [shouldPollCamera]);

  const cameraUrl = printer.media.hasCamera
    ? buildPrinterMediaUrl(
        mediaAccess,
        printer.id,
        "camera",
        `${printer.media.cameraRevision}-${frameTick}`,
      )
    : null;
  const coverUrl = printer.media.hasCoverImage
    ? buildPrinterMediaUrl(
        mediaAccess,
        printer.id,
        "cover",
        printer.media.coverUpdatedAt ?? printer.job.fileName ?? "cover",
      )
    : null;
  const skippedKey = printer.job.printableObjects
    .filter((obj) => obj.skipped)
    .map((obj) => obj.id)
    .join(",");
  const pickUrl = printer.media.hasPickImage
    ? buildPrinterMediaUrl(
        mediaAccess,
        printer.id,
        "pick",
        `${printer.media.coverUpdatedAt ?? printer.job.fileName ?? "pick"}-${skippedKey}`,
      )
    : null;

  const activeUrl =
    effectiveMode === "camera" ? cameraUrl : effectiveMode === "cover" ? coverUrl : pickUrl;
  const pipMode: PrinterViewportMode | null =
    effectiveMode === "camera"
      ? printer.media.hasCoverImage
        ? "cover"
        : printer.media.hasPickImage
          ? "pick"
          : null
      : printer.media.hasCamera
        ? "camera"
        : null;
  const pipUrl = pipMode === "camera" ? cameraUrl : pipMode === "cover" ? coverUrl : pickUrl;

  const frameAge = formatAgeLabel(printer.media.cameraUpdatedAt, nowMs);
  const isStaleCamera =
    effectiveMode === "camera" && (printer.media.cameraStale || !printer.online);

  const badgeLabel =
    effectiveMode === "cover"
      ? gt("3D Plate Preview")
      : effectiveMode === "pick"
        ? gt("Object Pick Map")
        : isStaleCamera
          ? gt("Last frame (offline)")
          : streamPaused
            ? gt("Paused")
            : frameAge
              ? gt("Camera · {age}", { age: frameAge })
              : gt("Camera");

  const imageError = activeUrl !== null && erroredUrl === activeUrl;

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border/70 bg-muted/40">
      {activeUrl && !imageError ? (
        <img
          src={activeUrl}
          alt={
            effectiveMode === "cover"
              ? gt("{printer} 3D plate cover preview", { printer: printer.label })
              : effectiveMode === "pick"
                ? gt("{printer} printable objects map", { printer: printer.label })
                : gt("{printer} live chamber camera", { printer: printer.label })
          }
          className={
            effectiveMode === "camera"
              ? "size-full object-cover"
              : "size-full bg-background/80 object-contain p-3"
          }
          onLoad={() => setErroredUrl(null)}
          onError={() => {
            setErroredUrl(activeUrl);
            onMediaError?.();
          }}
        />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground">
          <CameraOff className="size-7 opacity-50" />
          <p className="text-xs font-medium">
            {effectiveMode === "cover"
              ? gt("3D plate preview unavailable")
              : effectiveMode === "pick"
                ? gt("Object map unavailable")
                : printer.media.hasCamera
                  ? gt("Camera frame unavailable")
                  : gt("No camera feed configured")}
          </p>
        </div>
      )}

      {/* Top-left honest media & freshness pill */}
      <div className="pointer-events-none absolute top-2 left-2 flex items-center gap-1.5">
        <div className="rounded-md bg-popover/90 shadow-xs backdrop-blur-sm">
          <Badge
            size="sm"
            variant={
              effectiveMode !== "camera"
                ? "info"
                : isStaleCamera
                  ? "warning"
                  : streamPaused
                    ? "secondary"
                    : "success"
            }
          >
            {effectiveMode === "camera" ? (
              <Camera className="size-3" />
            ) : (
              <Layers className="size-3" />
            )}
            <span>{badgeLabel}</span>
          </Badge>
        </div>
      </div>

      {/* Top-right view mode quick toggle when pick image is also present */}
      {printer.media.hasCoverImage && printer.media.hasPickImage ? (
        <div className="absolute top-2 right-2 flex items-center gap-1">
          <Button
            size="xs"
            variant="overlay"
            onClick={() => onViewModeChange(effectiveMode === "pick" ? "cover" : "pick")}
          >
            {effectiveMode === "pick" ? gt("Plate") : gt("Objects")}
          </Button>
        </div>
      ) : null}

      {/* Bottom-left camera & lighting overlay controls */}
      <div className="absolute bottom-2 left-2 flex items-center gap-1">
        {printer.capabilities.canSetLight && onToggleLight ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="overlay"
                  disabled={!canControl || lightPending}
                  aria-label={
                    printer.lighting.chamberLight
                      ? gt("Turn chamber light off")
                      : gt("Turn chamber light on")
                  }
                  onClick={onToggleLight}
                >
                  <Lightbulb
                    className={
                      printer.lighting.chamberLight
                        ? "size-3.5 text-warning"
                        : "size-3.5 opacity-70"
                    }
                  />
                </Button>
              }
            />
            <TooltipPopup>
              {printer.lighting.chamberLight ? gt("Chamber light: On") : gt("Chamber light: Off")}
            </TooltipPopup>
          </Tooltip>
        ) : null}

        {effectiveMode === "camera" && printer.media.hasCamera ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="overlay"
                    aria-label={
                      streamPaused ? gt("Resume camera refresh") : gt("Pause camera refresh")
                    }
                    onClick={() => setStreamPaused((paused) => !paused)}
                  >
                    {streamPaused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                  </Button>
                }
              />
              <TooltipPopup>
                {streamPaused ? gt("Resume camera refresh") : gt("Pause camera refresh")}
              </TooltipPopup>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="overlay"
                    aria-label={gt("Refresh camera frame")}
                    onClick={() => {
                      setErroredUrl(null);
                      setFrameTick((current) => current + 1);
                    }}
                  >
                    <RefreshCw className="size-3.5" />
                  </Button>
                }
              />
              <TooltipPopup>{gt("Refresh frame")}</TooltipPopup>
            </Tooltip>
          </>
        ) : null}

        {activeUrl ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="overlay"
                  aria-label={gt("Download snapshot")}
                  render={
                    <a
                      href={activeUrl}
                      download={`${printer.id}-${effectiveMode}.${effectiveMode === "camera" ? "jpg" : "png"}`}
                      target="_blank"
                      rel="noreferrer"
                    />
                  }
                >
                  <Download className="size-3.5" />
                </Button>
              }
            />
            <TooltipPopup>{gt("Download image")}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>

      {/* Bottom-right clickable Picture-in-Picture swap thumbnail */}
      {pipMode && pipUrl ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={() => {
                  setErroredUrl(null);
                  onViewModeChange(pipMode);
                }}
                aria-label={
                  pipMode === "camera"
                    ? gt("Switch to live camera view")
                    : gt("Switch to 3D plate cover preview")
                }
                className="group absolute right-2 bottom-2 h-14 w-24 overflow-hidden rounded-md border border-border/80 bg-background/90 shadow-sm ring-1 ring-inset ring-foreground/10 transition hover:ring-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <img
                  src={pipUrl}
                  alt={pipMode === "camera" ? gt("Camera thumbnail") : gt("3D plate preview")}
                  className={
                    pipMode === "camera" ? "size-full object-cover" : "size-full object-contain p-1"
                  }
                />
                <span className="absolute inset-x-0 bottom-0 bg-background/80 px-1 py-0.5 text-center text-3xs font-medium text-foreground">
                  {pipMode === "camera" ? gt("Camera") : gt("3D Plate")}
                </span>
              </button>
            }
          />
          <TooltipPopup>
            {pipMode === "camera" ? gt("Swap to camera feed") : gt("Swap to 3D plate preview")}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}
