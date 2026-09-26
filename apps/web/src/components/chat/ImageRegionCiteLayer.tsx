import { useRef, type CSSProperties, type PointerEvent, type Ref } from "react";

import {
  imagePointFromClient,
  imageRegionBetween,
  isCitableImageRegion,
  type ImagePoint,
  type ImageRegion,
} from "~/lib/imageRegionCitation";

const REGION_BOX_CLASS_NAME =
  "pointer-events-none absolute rounded-[3px] border-2 border-primary bg-primary/10";

function regionStyle(region: ImageRegion): CSSProperties {
  return {
    left: `${region.x * 100}%`,
    top: `${region.y * 100}%`,
    width: `${region.width * 100}%`,
    height: `${region.height * 100}%`,
  };
}

function CitedRegion({ region, number }: { region: ImageRegion; number: number }) {
  return (
    <div
      className="pointer-events-none absolute rounded-[3px] border-2 border-primary"
      style={regionStyle(region)}
    >
      <span className="absolute top-0 left-0 rounded-br-[3px] bg-primary px-1 text-[10px] leading-4 font-medium text-primary-foreground">
        {number}
      </span>
    </div>
  );
}

/**
 * Covers a zoomable image while citing: draws the region being selected, the pending region, and
 * numbered regions already cited from this image. Positions are percentages of the image, so
 * zooming never needs a re-render. A drag moves its box directly, without React updates.
 */
export function ImageRegionCiteLayer({
  cited,
  pending,
  pendingRef,
  onSelect,
}: {
  cited: ReadonlyArray<ImageRegion>;
  pending: ImageRegion | null;
  pendingRef: Ref<HTMLDivElement>;
  /** Receives each finished drag, or null when a press cleared the pending region. */
  onSelect: (region: ImageRegion | null) => void;
}) {
  const dragRef = useRef<{ pointerId: number; start: ImagePoint } | null>(null);
  const dragBoxRef = useRef<HTMLDivElement>(null);

  const measure = (event: PointerEvent<HTMLDivElement>, start: ImagePoint) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const region = imageRegionBetween(
      start,
      imagePointFromClient({ x: event.clientX, y: event.clientY }, bounds),
    );
    return isCitableImageRegion(region, bounds) ? region : null;
  };
  const endDrag = () => {
    dragRef.current = null;
    if (dragBoxRef.current) dragBoxRef.current.style.display = "";
  };

  return (
    <div
      className="absolute inset-0 touch-none select-none"
      onPointerDown={(event) => {
        if (
          dragRef.current ||
          !event.isPrimary ||
          (event.pointerType === "mouse" && event.button !== 0)
        ) {
          return;
        }
        event.preventDefault();
        dragRef.current = {
          pointerId: event.pointerId,
          start: imagePointFromClient(
            { x: event.clientX, y: event.clientY },
            event.currentTarget.getBoundingClientRect(),
          ),
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        onSelect(null);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        const box = dragBoxRef.current;
        if (!drag || drag.pointerId !== event.pointerId || !box) return;
        const region = measure(event, drag.start);
        if (!region) {
          box.style.display = "";
          return;
        }
        Object.assign(box.style, regionStyle(region), { display: "block" });
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const region = measure(event, drag.start);
        endDrag();
        if (region) onSelect(region);
      }}
      onPointerCancel={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) endDrag();
      }}
      onLostPointerCapture={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) endDrag();
      }}
    >
      {cited.map((region, index) => (
        // Cited regions are only appended, so an index stays with its region.
        // oxlint-disable-next-line react/no-array-index-key
        <CitedRegion key={index} region={region} number={index + 1} />
      ))}
      {pending ? (
        <div ref={pendingRef} className={REGION_BOX_CLASS_NAME} style={regionStyle(pending)} />
      ) : null}
      <div ref={dragBoxRef} className={`${REGION_BOX_CLASS_NAME} hidden`} />
    </div>
  );
}
