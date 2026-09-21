// @effect-diagnostics globalTimers:off - Canvas-local wheel gesture expiry.
import {
  phoneWheelNavigation,
  type createPhoneInteraction,
} from "@t3tools/client-runtime/device/phone-interaction";

/** Canvas-local, non-passive listeners consume browser zoom. Safari reports cumulative pinch scale instead of Ctrl-wheel. */
export function bindPhoneTrackpad(
  canvas: Pick<
    HTMLCanvasElement,
    "addEventListener" | "removeEventListener" | "getBoundingClientRect"
  >,
  interaction: Pick<ReturnType<typeof createPhoneInteraction>, "navigate">,
  pinch?: {
    begin: (x: number, y: number) => boolean;
    move: (logScale: number) => void;
    end: () => void;
  },
) {
  let scale: number | null = null;
  let wheelActive = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    wheelActive = false;
    scale = null;
    pinch?.end();
  };
  const begin = (event: Event) => {
    const rect = canvas.getBoundingClientRect();
    const x = "clientX" in event && typeof event.clientX === "number" ? event.clientX : NaN;
    const y = "clientY" in event && typeof event.clientY === "number" ? event.clientY : NaN;
    pinch?.begin((x - rect.left) / rect.width, (y - rect.top) / rect.height);
  };
  const consume = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const wheel = (event: WheelEvent) => {
    consume(event);
    if (scale !== null) return;
    if (event.ctrlKey) {
      if (!wheelActive) {
        begin(event);
        wheelActive = true;
      }
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? canvas.getBoundingClientRect().height
            : 1;
      pinch?.move((-event.deltaY * unit) / 100);
      if (timer) clearTimeout(timer);
      timer = setTimeout(finish, 180);
      return;
    }
    if (wheelActive) finish();
    const rect = canvas.getBoundingClientRect();
    const navigation = phoneWheelNavigation({
      width: rect.width,
      height: rect.height,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      ctrlKey: event.ctrlKey,
    });
    if (navigation) interaction.navigate(navigation);
  };
  const gestureScale = (event: Event) => {
    if (
      !("scale" in event) ||
      typeof event.scale !== "number" ||
      !Number.isFinite(event.scale) ||
      event.scale <= 0
    )
      return null;
    return event.scale;
  };
  const start = (event: Event) => {
    consume(event);
    finish();
    begin(event);
    scale = gestureScale(event) ?? 1;
  };
  const change = (event: Event) => {
    consume(event);
    const next = gestureScale(event);
    if (scale === null || next === null) return;
    pinch?.move(Math.log(next / scale));
    scale = next;
  };
  const end = (event: Event) => {
    consume(event);
    finish();
  };
  canvas.addEventListener("wheel", wheel, { passive: false });
  canvas.addEventListener("gesturestart", start, { passive: false });
  canvas.addEventListener("gesturechange", change, { passive: false });
  canvas.addEventListener("gestureend", end, { passive: false });
  return {
    cancel() {
      finish();
    },
    dispose() {
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("gesturestart", start);
      canvas.removeEventListener("gesturechange", change);
      canvas.removeEventListener("gestureend", end);
      finish();
    },
  };
}
