import { useLayoutEffect, type PointerEvent as ReactPointerEvent } from "react";
import { type SensorProps } from "@dnd-kit/core";
import { getOwnerDocument, getWindow } from "@dnd-kit/utilities";

// Search unmounts the drag context while its owning Sidebar remains mounted.
export function SidebarDragLifecycle({ onUnmount }: { onUnmount: () => void }) {
  useLayoutEffect(() => onUnmount, [onUnmount]);
  return null;
}

type Options = {
  distance: number;
  onAttach: (sensor: SidebarPointerSensor) => void;
  onFinish: (started: boolean) => void;
};

/** A sidebar gesture ends on release, cancellation, or loss of its window.
 * Own the listeners so unmounting the list can cancel the sensor too. */
export class SidebarPointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent }: ReactPointerEvent) =>
        nativeEvent.isPrimary && nativeEvent.button === 0,
    },
  ];
  autoScrollEnabled = true;
  private phase: "pending" | "dragging" | "finished" = "pending";
  private readonly pointer: PointerEvent;
  private readonly document: Document;
  private readonly window: Window;

  constructor(private readonly props: SensorProps<Options>) {
    this.pointer = props.event as PointerEvent;
    this.document = getOwnerDocument(this.pointer.target);
    this.window = getWindow(this.pointer.target);
    this.document.addEventListener("pointermove", this.move, { passive: false, capture: true });
    this.document.addEventListener("pointerup", this.end, true);
    this.document.addEventListener("pointercancel", this.pointerCancel, true);
    this.document.addEventListener("keydown", this.keydown, true);
    this.document.addEventListener("visibilitychange", this.visibilityChange);
    this.window.addEventListener("blur", this.cancel);
    this.window.addEventListener("pagehide", this.cancel);
    this.window.addEventListener("resize", this.cancel);
    this.document.addEventListener("dragstart", this.preventDefault);
    this.document.addEventListener("contextmenu", this.preventDefault);
    props.options.onAttach(this);
    props.onPending(props.active, { distance: props.options.distance }, this.coordinates());
  }

  private coordinates = () => ({ x: this.pointer.clientX, y: this.pointer.clientY });
  private preventDefault = (event: Event) => event.preventDefault();
  private suppressClick = (event: Event) => event.stopPropagation();
  private clearSelection = () => this.document.getSelection()?.removeAllRanges();

  private move = (event: PointerEvent) => {
    if (this.phase === "finished" || event.pointerId !== this.pointer.pointerId) return;
    // A release outside the window can be missed. Never activate or continue
    // a drag when the initiating button is no longer held.
    if ((event.buttons & 1) === 0) return this.cancel();
    const coordinates = { x: event.clientX, y: event.clientY };
    if (this.phase === "pending") {
      const offset = {
        x: event.clientX - this.pointer.clientX,
        y: event.clientY - this.pointer.clientY,
      };
      if (Math.hypot(offset.x, offset.y) <= this.props.options.distance) {
        this.props.onPending(
          this.props.active,
          { distance: this.props.options.distance },
          this.coordinates(),
          offset,
        );
        return;
      }
      this.phase = "dragging";
      this.document.addEventListener("click", this.suppressClick, true);
      this.document.addEventListener("selectionchange", this.clearSelection);
      this.clearSelection();
      this.props.onStart(this.coordinates());
    }
    if (this.phase === "dragging") {
      if (event.cancelable) event.preventDefault();
      this.props.onMove(coordinates);
    }
  };

  private end = (event: PointerEvent) => {
    if (event.pointerId === this.pointer.pointerId) this.finish(false);
  };
  private pointerCancel = (event: PointerEvent) => {
    if (event.pointerId === this.pointer.pointerId) this.cancel();
  };
  private keydown = (event: KeyboardEvent) => {
    if (event.code === "Escape") this.cancel();
  };
  private visibilityChange = () => {
    if (this.document.hidden) this.cancel();
  };
  cancel = () => this.finish(true);

  private finish(cancelled: boolean) {
    if (this.phase === "finished") return;
    const aborted = this.phase === "pending";
    this.phase = "finished";
    this.document.removeEventListener("pointermove", this.move, true);
    this.document.removeEventListener("pointerup", this.end, true);
    this.document.removeEventListener("pointercancel", this.pointerCancel, true);
    this.document.removeEventListener("keydown", this.keydown, true);
    this.document.removeEventListener("visibilitychange", this.visibilityChange);
    this.window.removeEventListener("blur", this.cancel);
    this.window.removeEventListener("pagehide", this.cancel);
    this.window.removeEventListener("resize", this.cancel);
    this.document.removeEventListener("dragstart", this.preventDefault);
    this.document.removeEventListener("contextmenu", this.preventDefault);
    this.document.removeEventListener("selectionchange", this.clearSelection);
    // Keep the release click from opening the thread after a drag.
    this.window.setTimeout(() => {
      this.document.removeEventListener("click", this.suppressClick, true);
    }, 0);
    try {
      // Release the sidebar preview before dnd-kit clears its transforms.
      // Its public end/cancel event can be omitted before its first layout.
      this.props.options.onFinish(!aborted);
    } finally {
      if (aborted) this.props.onAbort(this.props.active);
      if (cancelled) this.props.onCancel();
      else this.props.onEnd();
    }
  }
}
