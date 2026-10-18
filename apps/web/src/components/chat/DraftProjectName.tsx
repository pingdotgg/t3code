import { useLayoutEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";

import { truncateProjectName } from "./DraftProjectName.logic";

export function DraftProjectName({ value }: { value: string }) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const [displayName, setDisplayName] = useState(value);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const context = document.createElement("canvas").getContext("2d");
    if (!container || !context) return;

    const update = () => {
      const style = getComputedStyle(container);
      context.font = style.font;
      context.letterSpacing = style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
      setDisplayName(
        truncateProjectName(
          value,
          container.getBoundingClientRect().width,
          (text) => context.measureText(text).width,
        ),
      );
    };
    update();
    const stopObserving = observeResize(container, update);
    document.fonts.addEventListener("loadingdone", update);
    return () => {
      stopObserving();
      document.fonts.removeEventListener("loadingdone", update);
    };
  }, [value]);

  return (
    <span
      ref={containerRef}
      className="inline-grid min-w-0 max-w-full overflow-hidden align-baseline whitespace-nowrap"
    >
      {/* Keep the full name's intrinsic width so fitting the visible text cannot shrink its budget. */}
      <span
        aria-hidden="true"
        className="invisible col-start-1 row-start-1 min-w-0 overflow-hidden select-none"
      >
        {value}
      </span>
      <span aria-label={value} className="col-start-1 row-start-1 min-w-0 overflow-hidden">
        {displayName}
      </span>
    </span>
  );
}
