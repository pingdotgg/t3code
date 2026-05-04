"use client";

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

export function AnimatedHeight({ children }: { readonly children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    let firstFrameId: number | null = null;
    let secondFrameId: number | null = null;

    const updateHeight = () => {
      const nextHeight = Math.ceil(element.scrollHeight || element.getBoundingClientRect().height);
      setHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
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
    const resizeObserver = new ResizeObserver(updateHeightAfterPaint);
    resizeObserver.observe(element);
    return () => {
      resizeObserver.disconnect();
      cancelPendingFrames();
    };
  }, []);

  return (
    <div
      className="overflow-hidden transition-[height] duration-200 ease-out motion-reduce:transition-none"
      style={height === null ? undefined : { height }}
    >
      <div ref={contentRef}>{children}</div>
    </div>
  );
}
