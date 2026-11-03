import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import { useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { AndroidFoldError, setAndroidFold, type AndroidFoldPosture } from "./deviceFold";
import { androidFoldReadAtom, androidFoldViewAtom, foldAngle, NOOP_ATOM } from "./deviceHubAtoms";
import { DeviceDuoGlyph } from "./DeviceDuoGlyph";

export function DeviceAndroidFoldControls(props: {
  readonly access: DeviceHubAccess;
  readonly deviceKey: string;
  readonly deviceId: string;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly screenWidth: number | undefined;
  readonly screenHeight: number | undefined;
  readonly renewAccess: () => Promise<DeviceHubAccess | null>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const { access, deviceKey, deviceId, visible, enabled, screenWidth, screenHeight } = props;
  const viewAtom = androidFoldViewAtom(deviceKey);
  const { fold } = useAtomValue(viewAtom);
  const setView = useAtomSet(viewAtom);
  // A change in flight owns the posture; reading meanwhile could show the old one.
  useAtomMount(
    visible && enabled && !pending && screenWidth && screenHeight
      ? androidFoldReadAtom({ deviceKey, access, deviceId, screenWidth, screenHeight })
      : NOOP_ATOM,
  );

  if (!fold?.supported || !props.visible) return null;

  const setAngle = (angle: number) => setView((current) => ({ ...current, angle }));
  const change = (posture: AndroidFoldPosture) => {
    if (busy.current || !props.enabled) return;
    busy.current = true;
    setPending(true);
    setError(null);
    setAngle(posture === "closed" ? 0 : 180);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    const send = (access: DeviceHubAccess) =>
      setAndroidFold(access, props.deviceId, posture, controller.signal);
    void send(props.access)
      .catch(async (cause: unknown) => {
        // Hub tickets expire after a few minutes, while the panel stays open much longer.
        if (!(cause instanceof AndroidFoldError && cause.status === 401)) throw cause;
        const renewed = await props.renewAccess();
        if (!renewed || controller.signal.aborted) throw cause;
        return send(renewed);
      })
      .then((next) => setView({ fold: next, angle: foldAngle(next) }))
      .catch((cause: unknown) => {
        setAngle(foldAngle(fold));
        setError(
          controller.signal.aborted
            ? "Fold command timed out."
            : cause instanceof Error
              ? cause.message
              : "Could not change fold posture.",
        );
      })
      .finally(() => {
        window.clearTimeout(timeout);
        busy.current = false;
        setPending(false);
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
