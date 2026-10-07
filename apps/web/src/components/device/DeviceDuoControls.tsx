import {
  duoFoldState,
  type DuoCommand,
  type DuoControlState,
} from "@t3tools/client-runtime/device/duo-control";
import type { DeviceScreenSize } from "@t3tools/client-runtime/device/stream";
import { DeviceDuoGlyph } from "./DeviceDuoGlyph";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

const FOLDS = [
  { id: "closed", angle: 0 },
  { id: "half", angle: 90 },
  { id: "open", angle: 180 },
] as const;
const STANDS = [
  { id: "laptop", label: "Laptop stand" },
  { id: "tent", label: "Tent stand" },
] as const;

/**
 * Fold shapes move only the hinge, so the device opens around whichever edge it
 * currently rests on: a vertical phone opens as a book into a landscape tablet,
 * a horizontal one as a laptop into a portrait tablet. Stands are native presets
 * that also place the device. Pinching supplies continuous hinge control.
 */
export function DeviceDuoControls(props: {
  screen: DeviceScreenSize;
  state: DuoControlState;
  enabled: boolean;
  onCommand: (command: DuoCommand) => void;
}) {
  const { screen } = props;
  const { fold, stand, phoneVertical } = duoFoldState(screen);
  const foldLabels = {
    closed: "Closed",
    half: phoneVertical ? "Book" : "Laptop",
    open: "Open",
  };
  const button = (
    key: string,
    label: string,
    pressed: boolean,
    onClick: () => void,
    glyph: React.ReactNode,
  ) => (
    <Tooltip key={key}>
      <TooltipTrigger
        render={
          <Button
            size="icon"
            variant={pressed ? "secondary" : "ghost"}
            disabled={!props.enabled}
            aria-label={label}
            aria-pressed={pressed}
            data-pressed={pressed ? "" : undefined}
            onClick={onClick}
          />
        }
      >
        {glyph}
      </TooltipTrigger>
      <TooltipPopup side="left">{label}</TooltipPopup>
    </Tooltip>
  );
  const group =
    "pointer-events-auto flex shrink-0 flex-col items-center gap-1 rounded-full border border-border/50 bg-background/80 p-1 shadow-sm";
  return (
    <div aria-label="iPhone Duo stands" className="flex flex-col items-center gap-2">
      <div role="group" aria-label="Fold shape" className={group}>
        {FOLDS.map(({ id, angle: value }) =>
          button(
            id,
            foldLabels[id],
            !stand && fold === id,
            () => props.onCommand({ control: "angle", value }),
            <DeviceDuoGlyph pose={id === "half" ? "book" : id} vertical={phoneVertical} />,
          ),
        )}
      </div>
      <div role="group" aria-label="Device stance" className={group}>
        {STANDS.map(({ id, label }) =>
          button(
            id,
            label,
            screen.hingePose === id,
            () => props.onCommand({ control: "pose", value: id }),
            <DeviceDuoGlyph pose={id} />,
          ),
        )}
      </div>
      {props.state.error ? (
        <Tooltip>
          <TooltipTrigger
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
          />
          <TooltipPopup side="left">{props.state.error}</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}
