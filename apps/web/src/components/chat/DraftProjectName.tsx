import { useLayoutEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";

import { truncateProjectName } from "./DraftProjectName.logic";

export function DraftProjectName({ value }: { value: string }) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const measurementRef = useRef<HTMLSpanElement>(null);
  const [displayName, setDisplayName] = useState(value);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measurement = measurementRef.current;
    if (!container || !measurement) return;

    const update = () => {
      // Canvas text metrics can differ from layout for the same font, weight, and zoom.
      // Measure in the DOM so a name that fits never loses characters to that mismatch.
      setDisplayName(
        truncateProjectName(value, container.getBoundingClientRect().width, (text) => {
          measurement.textContent = text;
          return measurement.getBoundingClientRect().width;
        }),
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
      className="relative inline-grid min-w-0 max-w-full overflow-hidden align-baseline whitespace-nowrap"
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
      <span
        ref={measurementRef}
        aria-hidden="true"
        className="invisible absolute top-0 left-0 w-max select-none"
      />
    </span>
  );
}
