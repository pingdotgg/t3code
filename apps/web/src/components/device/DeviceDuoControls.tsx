import { msg, useGT, useMessages } from "gt-react";
import { useState } from "react";
import {
  duoFoldState,
  duoHoldOrientation,
  type DuoCommand,
  type DuoControlState,
} from "@t3tools/client-runtime/device/duo-control";
import type { DeviceScreenSize } from "@t3tools/client-runtime/device/stream";
import { DeviceDuoGlyph } from "./DeviceDuoGlyph";
import { Button } from "~/components/ui/button";
import { SharedTooltipTrigger } from "~/components/ui/shared-tooltip";

const FOLDS = [
  { id: "closed", angle: 0 },
  { id: "half", angle: 90 },
  { id: "open", angle: 180 },
] as const;
const STANDS = [
  { id: "laptop", label: msg("Laptop stand") },
  { id: "tent", label: msg("Tent stand") },
] as const;

export function DeviceDuoControls(props: {
  screen: DeviceScreenSize;
  state: DuoControlState;
  enabled: boolean;
  onCommand: (command: DuoCommand) => void;
}) {
  const { screen } = props;
  const gt = useGT();
  const m = useMessages();
  const { fold, stand, phoneVertical: reportedVertical, settled } = duoFoldState(screen);
  const [settledVertical, setSettledVertical] = useState(reportedVertical);
  if (settled && settledVertical !== reportedVertical) setSettledVertical(reportedVertical);
  const [standVertical, setStandVertical] = useState(settledVertical);
  const phoneVertical = stand ? standVertical : settledVertical;
  // Only one command can wait; defer fold controls until stand rotation and queued commands settle in the
  // correct display frame.
  const foldWaits = props.state.pending && (stand || props.state.requested?.control === "pose");
  const foldLabels = {
    closed: gt("Closed", { $context: "iPhone Duo fold shape" }),
    half: phoneVertical
      ? gt("Book", { $context: "iPhone Duo fold shape" })
      : gt("Laptop", { $context: "iPhone Duo fold shape" }),
    open: gt("Open", { $context: "iPhone Duo fold shape" }),
  };
  const button = (
    key: string,
    label: string,
    pressed: boolean,
    onClick: () => void,
    glyph: React.ReactNode,
    waits = false,
  ) => (
    <SharedTooltipTrigger
      key={key}
      render={
        <Button
          size="icon"
          variant={pressed ? "secondary" : "ghost"}
          disabled={!props.enabled || waits}
          aria-label={label}
          aria-pressed={pressed}
          data-pressed={pressed ? "" : undefined}
          onClick={onClick}
        />
      }
      label={label}
      side="left"
    >
      {glyph}
    </SharedTooltipTrigger>
  );
  const group =
    "pointer-events-auto flex shrink-0 flex-col items-center gap-1 rounded-full border border-border/50 bg-background/80 p-1 shadow-sm";
  return (
    <div aria-label={gt("iPhone Duo stands")} className="flex flex-col items-center gap-2">
      <div role="group" aria-label={gt("Fold shape")} className={group}>
        {FOLDS.map(({ id, angle: value }) =>
          button(
            id,
            foldLabels[id],
            !stand && fold === id,
            () => {
              if (stand)
                props.onCommand({
                  control: "orientation",
                  value: duoHoldOrientation(standVertical, screen.screenId),
                });
              props.onCommand({ control: "angle", value });
            },
            <DeviceDuoGlyph pose={id === "half" ? "book" : id} rotated={!phoneVertical} />,
            foldWaits,
          ),
        )}
      </div>
      <div role="group" aria-label={gt("Device stance")} className={group}>
        {STANDS.map(({ id, label }) =>
          button(
            id,
            m(label),
            screen.hingePose === id,
            () => {
              if (!stand) setStandVertical(settledVertical);
              props.onCommand({ control: "pose", value: id });
            },
            <DeviceDuoGlyph pose={id} />,
          ),
        )}
      </div>
      {props.state.error ? (
        <SharedTooltipTrigger
          render={
            <span
              tabIndex={0}
              role="alert"
              aria-label={props.state.error}
              className="pointer-events-auto text-xs text-destructive"
            >
              !
            </span>
          }
          label={props.state.error}
          side="left"
        />
      ) : null}
    </div>
  );
}
