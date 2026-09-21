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
) {
  let scale: number | null = null;
  const consume = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const wheel = (event: WheelEvent) => {
    consume(event);
    if (scale !== null || event.ctrlKey) return;
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
    scale = gestureScale(event) ?? 1;
  };
  const change = (event: Event) => {
    consume(event);
    const next = gestureScale(event);
    if (scale === null || next === null) return;
    scale = next;
  };
  const end = (event: Event) => {
    consume(event);
    scale = null;
  };
  canvas.addEventListener("wheel", wheel, { passive: false });
  canvas.addEventListener("gesturestart", start, { passive: false });
  canvas.addEventListener("gesturechange", change, { passive: false });
  canvas.addEventListener("gestureend", end, { passive: false });
  return {
    cancel() {
      scale = null;
    },
    dispose() {
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("gesturestart", start);
      canvas.removeEventListener("gesturechange", change);
      canvas.removeEventListener("gestureend", end);
      scale = null;
    },
  };
}
