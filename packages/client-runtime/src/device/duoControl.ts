// @effect-diagnostics globalTimers:off - The stream owns this browser control queue and its timeout.
import type { DeviceScreenSize } from "./stream.ts";

/** Native hinge presets. Each one also sets the device's physical orientation. */
export type DuoPose = "closed" | "book" | "open" | "laptop" | "tent";
export type DuoOrientation =
  | "portrait"
  | "landscape_left"
  | "portrait_upside_down"
  | "landscape_right";
export type DuoCommand =
  | { control: "angle"; value: number }
  | { control: "pose"; value: DuoPose }
  | { control: "table"; value: boolean }
  | { control: "physical"; value: "faceup" | "facedown" }
  | { control: "orientation"; value: DuoOrientation };
export type DuoControlState = {
  pending: boolean;
  requested: DuoCommand | null;
  error: string | null;
};

/**
 * The fold the device is in and the way it is held. Missing hinge fields fall back the same way
 * the 3D view does, so controls never disagree with what is drawn. The inner panel is mounted a
 * quarter turn from the cover, so its landscape orientation means a vertical phone.
 */
export function duoFoldState(
  screen: Pick<DeviceScreenSize, "orientation" | "screenId" | "hingeAngle" | "hingePose">,
) {
  const angle = screen.hingeAngle ?? (screen.screenId === 1 ? 0 : 180);
  const landscape = screen.orientation.startsWith("landscape");
  return {
    fold: angle === 0 ? "closed" : angle === 180 ? "open" : "half",
    stand: screen.hingePose === "laptop" || screen.hingePose === "tent",
    phoneVertical: screen.screenId === 1 ? !landscape : landscape,
  } as const;
}

/** One in-flight native transaction. Hinge motion coalesces; presets replace queued motion. Nothing replays after reconnect. */
export function createDuoControl(options: {
  send: (request: { requestId: number; command: DuoCommand }) => boolean;
  onChange: (state: DuoControlState) => void;
  timeoutMs?: number;
}) {
  let nextId = 1;
  let active: { requestId: number; command: DuoCommand } | null = null;
  let queued: DuoCommand | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const publish = (error: string | null = null) =>
    options.onChange({ pending: !!active, requested: queued ?? active?.command ?? null, error });
  const clear = (error: string | null = null) => {
    if (timer) clearTimeout(timer);
    timer = null;
    active = null;
    queued = null;
    publish(error);
  };
  const drain = () => {
    if (active || !queued) return;
    active = { requestId: nextId++, command: queued };
    queued = null;
    const id = active.requestId;
    timer = setTimeout(() => {
      if (active?.requestId === id) clear("Device control timed out. Its position is unknown.");
    }, options.timeoutMs ?? 5_000);
    publish();
    if (!options.send(active)) clear("Device is disconnected.");
  };
  return {
    enqueue(command: DuoCommand) {
      if (
        command.control === "angle" &&
        (!Number.isFinite(command.value) || command.value < 0 || command.value > 180)
      )
        return;
      queued = command;
      if (active) publish();
      else drain();
    },
    receive(reply: { requestId: number; ok: boolean; error?: string }) {
      if (!active || reply.requestId !== active.requestId) return;
      if (timer) clearTimeout(timer);
      timer = null;
      active = null;
      if (!reply.ok) {
        clear(reply.error ?? "Device control failed. Its position is unknown.");
        return;
      }
      if (queued) drain();
      else publish();
    },
    clear,
  };
}

/** A pinch keeps its own accumulator across asynchronous native acknowledgements. */
export function createDuoPinch(options: {
  angle: () => number;
  contains: (x: number, y: number) => boolean;
  change: (angle: number | null) => void;
}) {
  let angle: number | null = null;
  return {
    begin(x: number, y: number) {
      if (!options.contains(x, y)) return false;
      angle = Math.max(0, Math.min(180, options.angle()));
      return true;
    },
    move(logScale: number) {
      if (angle === null || !Number.isFinite(logScale)) return;
      const next = Math.max(0, Math.min(180, angle + logScale * 120));
      if (next === angle) return;
      angle = next;
      options.change(next);
    },
    end() {
      if (angle === null) return;
      angle = null;
      options.change(null);
    },
    get active() {
      return angle !== null;
    },
  };
}
