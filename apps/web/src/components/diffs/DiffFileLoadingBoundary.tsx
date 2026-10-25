import { useEffect, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { observeIntersection } from "~/lib/observeIntersection";
import { DiffFileHeaderSkeleton } from "../DiffPanelShell";

export function DiffFileLoadingBoundary({ load, count }: { load: () => void; count: number }) {
  const [isNear, setIsNear] = useState(false);
  const loadLatest = useStableCallback(load);
  // A fresh observe redelivers the current intersection, so this ref must keep its identity
  // across renders: it captures nothing but the state setter.
  const observe = (node: HTMLDivElement | null) => {
    if (!node) return;
    return observeIntersection(node, (entry) => setIsNear(entry.isIntersecting), {
      rootMargin: "600px",
    });
  };
  // A settled batch shrinks `count` without moving the boundary out of range, and no new
  // intersection entry arrives for that, so ask for the next batch whenever it changes.
  useEffect(() => {
    if (isNear && count > 0) loadLatest();
  }, [isNear, count, loadLatest]);

  return (
    <div ref={observe} role="status" aria-label="Loading diff…">
      {Array.from({ length: Math.min(count, 4) }, (_, index) => (
        <div key={index} aria-hidden className="border-b border-border/40">
          <DiffFileHeaderSkeleton titleWidth="medium" />
        </div>
      ))}
    </div>
  );
}
