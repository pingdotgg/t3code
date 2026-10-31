import {
  HTML_RENDER_POINTER_RELEASE_METHOD,
  readHtmlRenderPointerHeld,
  readHtmlRenderPointerRelease,
} from "@t3tools/shared/htmlRender";
import { useLayoutEffect, useState, type RefObject } from "react";

export function useHtmlRenderPointerHold(frameRef: RefObject<HTMLIFrameElement | null>) {
  const [pointerHeld, setPointerHeld] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- bridges pointer releases across sandboxed frames and their host before the page can report a hold
  useLayoutEffect(() => {
    let held = false;
    const release = (event: Event) => {
      if (
        !held ||
        (event instanceof PointerEvent && event.type === "pointermove" && event.buttons !== 0)
      )
        return;
      const pointerId =
        event instanceof PointerEvent
          ? event.pointerId
          : event instanceof CustomEvent && typeof event.detail === "number"
            ? event.detail
            : undefined;
      frameRef.current?.contentWindow?.postMessage(
        {
          jsonrpc: "2.0",
          method: HTML_RENDER_POINTER_RELEASE_METHOD,
          params: { pointerId },
        },
        "*",
      );
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const pointerHeld = readHtmlRenderPointerHeld(event.data);
      if (pointerHeld !== undefined) {
        held = pointerHeld;
        setPointerHeld(pointerHeld);
      }
      const pointerId = readHtmlRenderPointerRelease(event.data);
      if (pointerId !== undefined) {
        window.dispatchEvent(
          new CustomEvent(HTML_RENDER_POINTER_RELEASE_METHOD, { detail: pointerId }),
        );
      }
    };
    window.addEventListener("message", onMessage);
    const events = [
      "pointerup",
      "pointercancel",
      "pointermove",
      "blur",
      HTML_RENDER_POINTER_RELEASE_METHOD,
    ];
    for (const event of events) window.addEventListener(event, release, true);
    return () => {
      window.removeEventListener("message", onMessage);
      for (const event of events) window.removeEventListener(event, release, true);
    };
  }, [frameRef]);
  return pointerHeld;
}
