interface Point {
  readonly x: number;
  readonly y: number;
}

export type PhoneNavigation =
  | { readonly type: "orbit"; readonly x: number; readonly y: number }
  | { readonly type: "zoom"; readonly delta: number };

/** Browser wheel units vary by device. Navigation uses viewport fractions and logarithmic zoom. */
export function phoneWheelNavigation(input: {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly width: number;
  readonly height: number;
}): PhoneNavigation | null {
  const { deltaX, deltaY, deltaMode, ctrlKey, width, height } = input;
  if (![deltaX, deltaY, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
    return null;
  if (deltaMode !== 0 && deltaMode !== 1 && deltaMode !== 2) return null;
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? height : 1;
  const clamp = (value: number, limit: number) => Math.min(limit, Math.max(-limit, value));
  if (ctrlKey) return { type: "zoom", delta: clamp(-deltaY * unit * 0.01, 1) };
  return {
    type: "orbit",
    x: clamp((-deltaX * unit) / width, 0.25),
    y: clamp((-deltaY * unit) / height, 0.25),
  };
}

/** A single pointer owns either a device gesture or an orbit until released or cancelled. */
export function createPhoneInteraction(options: {
  readonly screenPoint: (point: Point, captured: boolean) => Point | null;
  readonly touch: (phase: "begin" | "move" | "end", point: Point) => void;
  readonly orbit: (deltaX: number, deltaY: number) => void;
  readonly zoomBy: (logDelta: number) => void;
}) {
  let active: { id: number; mode: "touch" | "orbit"; last: Point; screen: Point | null } | null =
    null;
  return {
    navigate(gesture: PhoneNavigation) {
      // Moving the camera during a captured device touch would change its projected coordinates.
      if (active) return false;
      if (gesture.type === "zoom") options.zoomBy(gesture.delta);
      else options.orbit(gesture.x, gesture.y);
      return true;
    },
    begin(id: number, point: Point, forceOrbit = false) {
      if (active) return false;
      const screen = forceOrbit ? null : options.screenPoint(point, false);
      active = { id, mode: screen ? "touch" : "orbit", last: point, screen };
      if (screen) options.touch("begin", screen);
      return true;
    },
    move(id: number, point: Point) {
      if (active?.id !== id) return;
      if (active.mode === "touch") {
        const screen = options.screenPoint(point, true);
        if (screen) {
          active.screen = screen;
          options.touch("move", screen);
        }
      } else {
        options.orbit(point.x - active.last.x, point.y - active.last.y);
      }
      active.last = point;
    },
    end(id?: number) {
      if (!active || (id !== undefined && active.id !== id)) return;
      const previous = active;
      active = null;
      if (previous.mode === "touch" && previous.screen) options.touch("end", previous.screen);
    },
  };
}
