import {
  DUO_POSES,
  type DuoCommand,
  type DuoControlState,
} from "@t3tools/client-runtime/device/duo-control";
import type { DeviceScreenSize } from "@t3tools/client-runtime/device/stream";
import { Button } from "~/components/ui/button";

export function DeviceDuoControls(props: {
  screen: DeviceScreenSize;
  state: DuoControlState;
  enabled: boolean;
  onCommand: (command: DuoCommand) => void;
}) {
  const requested = props.state.requested;
  const angle =
    requested?.control === "angle"
      ? requested.value
      : requested?.control === "pose"
        ? DUO_POSES.find((pose) => pose.id === requested.value)?.angle
        : props.screen.hingeAngle;
  return (
    <div className="absolute inset-x-3 bottom-3 z-20 mx-auto flex w-fit max-w-[calc(100%-1.5rem)] flex-col gap-2 rounded-xl border border-border/60 bg-background/95 p-2 shadow-sm">
      <div
        className="flex flex-wrap justify-center gap-1"
        role="group"
        aria-label="iPhone Duo position"
      >
        {DUO_POSES.map((pose) => (
          <Button
            key={pose.id}
            size="xs"
            variant={props.screen.hingePose === pose.id ? "secondary" : "ghost"}
            disabled={!props.enabled}
            aria-pressed={props.screen.hingePose === pose.id}
            onClick={() => props.onCommand({ control: "pose", value: pose.id })}
          >
            {pose.label}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-2 px-1">
        <input
          aria-label="Hinge angle"
          type="range"
          min={0}
          max={180}
          step={1}
          value={angle ?? (props.screen.screenId === 1 ? 0 : 180)}
          disabled={!props.enabled}
          className="min-w-0 flex-1 accent-primary"
          onChange={(event) =>
            props.onCommand({ control: "angle", value: Number(event.target.value) })
          }
        />
        <span
          className="w-9 text-right text-xs tabular-nums text-muted-foreground"
          aria-live="polite"
        >
          {angle === undefined ? "?" : `${Math.round(angle)}°`}
        </span>
        <Button
          size="xs"
          variant={props.screen.tableMode ? "secondary" : "ghost"}
          disabled={!props.enabled || !props.screen.tableModeAvailable || props.state.pending}
          aria-pressed={props.screen.tableMode ?? false}
          onClick={() => props.onCommand({ control: "table", value: !props.screen.tableMode })}
        >
          Table
        </Button>
      </div>
      {props.state.error ? (
        <p role="alert" className="max-w-72 px-1 text-xs text-destructive">
          {props.state.error}
        </p>
      ) : null}
    </div>
  );
}
