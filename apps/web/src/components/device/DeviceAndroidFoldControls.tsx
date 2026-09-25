import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  readAndroidFold,
  setAndroidFold,
  type AndroidFoldPosture,
  type AndroidFoldState,
} from "./deviceFold";
import { DeviceDuoGlyph } from "./DeviceDuoGlyph";

/** Capability comes from the emulator, not its AVD name or screen dimensions. */
export function DeviceAndroidFoldControls(props: {
  readonly access: DeviceHubAccess;
  readonly deviceId: string;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly screenWidth: number | undefined;
  readonly screenHeight: number | undefined;
  readonly onFoldAngle: (angle: number | null) => void;
}) {
  const [fold, setFold] = useState<AndroidFoldState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const { access, deviceId, visible, enabled, screenWidth, screenHeight, onFoldAngle } = props;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!visible || !enabled || pending || !screenWidth || !screenHeight) return;
    const controller = new AbortController();
    let retry: number | undefined;
    const read = () => {
      void readAndroidFold(access, deviceId, controller.signal)
        .then((next) => {
          if (!controller.signal.aborted) {
            setFold(next);
            onFoldAngle(
              next.supported ? (next.hingeAngle ?? (next.posture === "closed" ? 0 : 180)) : null,
            );
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) retry = window.setTimeout(read, 3_000);
        });
    };
    read();
    return () => {
      controller.abort();
      window.clearTimeout(retry);
    };
  }, [access, deviceId, visible, enabled, screenWidth, screenHeight, pending, onFoldAngle]);

  if (!fold?.supported || !props.visible) return null;

  const change = (posture: AndroidFoldPosture) => {
    if (busy.current || !props.enabled) return;
    busy.current = true;
    setPending(true);
    setError(null);
    props.onFoldAngle(posture === "closed" ? 0 : 180);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    void setAndroidFold(props.access, props.deviceId, posture, controller.signal)
      .then((next) => {
        if (mounted.current) {
          setFold(next);
          props.onFoldAngle(next.hingeAngle ?? (next.posture === "closed" ? 0 : 180));
        }
      })
      .catch((cause: unknown) => {
        if (mounted.current) {
          props.onFoldAngle(fold.hingeAngle ?? (fold.posture === "closed" ? 0 : 180));
          setError(
            controller.signal.aborted
              ? "Fold command timed out."
              : cause instanceof Error
                ? cause.message
                : "Could not change fold posture.",
          );
        }
      })
      .finally(() => {
        window.clearTimeout(timeout);
        busy.current = false;
        if (mounted.current) setPending(false);
      });
  };

  return (
    <div aria-label="Android fold controls" className="flex flex-col items-center gap-2">
      <div className="pointer-events-auto flex shrink-0 flex-col items-center gap-1 rounded-full border border-border/50 bg-background/80 p-1 shadow-sm">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon"
                variant={fold.posture === "closed" ? "secondary" : "ghost"}
                aria-label="Fold device"
                aria-pressed={fold.posture === "closed"}
                disabled={pending || !props.enabled}
                onClick={() => change("closed")}
              />
            }
          >
            <DeviceDuoGlyph pose="closed" />
          </TooltipTrigger>
          <TooltipPopup side="left">Fold device</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon"
                variant={fold.posture === "opened" ? "secondary" : "ghost"}
                aria-label="Unfold device"
                aria-pressed={fold.posture === "opened"}
                disabled={pending || !props.enabled}
                onClick={() => change("opened")}
              />
            }
          >
            <DeviceDuoGlyph pose="open" />
          </TooltipTrigger>
          <TooltipPopup side="left">Unfold device</TooltipPopup>
        </Tooltip>
      </div>
      {error ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                tabIndex={0}
                role="alert"
                aria-label={error}
                className="pointer-events-auto text-xs text-destructive"
              >
                !
              </span>
            }
          />
          <TooltipPopup side="left">{error}</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}
