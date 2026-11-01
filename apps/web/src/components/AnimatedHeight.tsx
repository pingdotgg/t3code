import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { observeResize } from "../lib/observeResize";

const HEIGHT_TRANSITION_FALLBACK_MS = 250;

export function AnimatedHeight({
  children,
  holdHeight = false,
}: {
  readonly children: ReactNode;
  readonly holdHeight?: boolean;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [heightState, setHeightState] = useState<{
    readonly height: number | null;
    readonly isClipping: boolean;
  }>({ height: null, isClipping: false });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fallback timer that ends clipping when the height transition never reports its end
  useEffect(() => {
    if (!heightState.isClipping) return;
    const timeoutId = window.setTimeout(() => {
      setHeightState((currentState) =>
        currentState.isClipping ? { ...currentState, isClipping: false } : currentState,
      );
    }, HEIGHT_TRANSITION_FALLBACK_MS);
    return () => window.clearTimeout(timeoutId);
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A height change mid-transition starts a new transition, so the fallback timer restarts.
    heightState.height,
    heightState.isClipping,
  ]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the content element and observes its size before paint to animate height
  useLayoutEffect(() => {
    if (holdHeight) return;
    const element = contentRef.current;
    if (!element) return;
    let firstFrameId: number | null = null;
    let secondFrameId: number | null = null;

    const updateHeight = () => {
      const nextHeight = Math.ceil(element.scrollHeight || element.getBoundingClientRect().height);
      setHeightState((currentState) => {
        if (currentState.height === nextHeight) return currentState;
        return {
          height: nextHeight,
          isClipping: currentState.height !== null,
        };
      });
    };
    const cancelPendingFrames = () => {
      if (firstFrameId !== null) {
        window.cancelAnimationFrame(firstFrameId);
        firstFrameId = null;
      }
      if (secondFrameId !== null) {
        window.cancelAnimationFrame(secondFrameId);
        secondFrameId = null;
      }
    };
    const updateHeightAfterPaint = () => {
      cancelPendingFrames();
      updateHeight();
      firstFrameId = window.requestAnimationFrame(() => {
        firstFrameId = null;
        updateHeight();
        secondFrameId = window.requestAnimationFrame(() => {
          secondFrameId = null;
          updateHeight();
        });
      });
    };

    updateHeightAfterPaint();
    const stopObserving = observeResize(element, updateHeightAfterPaint);
    return () => {
      stopObserving();
      cancelPendingFrames();
    };
  }, [holdHeight]);

  return (
    <div
      data-slot="animated-height"
      className="transition-[height] duration-200 ease-out motion-reduce:transition-none [overflow-clip-margin:2px]"
      style={
        heightState.height === null
          ? undefined
          : {
              height: heightState.height,
              overflow: holdHeight || heightState.isClipping ? "clip" : "visible",
            }
      }
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== "height") return;
        setHeightState((currentState) =>
          currentState.isClipping ? { ...currentState, isClipping: false } : currentState,
        );
      }}
    >
      <div ref={contentRef} style={holdHeight ? { height: "100%" } : undefined}>
        {children}
      </div>
    </div>
  );
}
