import { useEffect, useRef } from "react";
import { DiffFileHeaderSkeleton } from "../DiffPanelShell";

/** Fetch ahead of the bottom edge without displaying empty file headers. */
export function DiffFileLoadingBoundary({ load, count }: { load: () => void; count: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load();
      },
      { rootMargin: "600px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [load]);
  return (
    <div ref={ref} role="status" aria-label="Loading diff…">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} aria-hidden className="border-b border-border/40">
          <DiffFileHeaderSkeleton titleClassName="w-1/2 max-w-64" />
        </div>
      ))}
    </div>
  );
}
