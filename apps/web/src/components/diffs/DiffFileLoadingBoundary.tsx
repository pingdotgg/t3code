import { observeIntersection } from "~/lib/observeIntersection";
import { DiffFileHeaderSkeleton } from "../DiffPanelShell";

export function DiffFileLoadingBoundary({ load, count }: { load: () => void; count: number }) {
  return (
    <div
      ref={(node) => {
        if (!node) return;
        return observeIntersection(
          node,
          (entry) => {
            if (entry.isIntersecting) load();
          },
          { rootMargin: "600px" },
        );
      }}
      role="status"
      aria-label="Loading diff…"
    >
      {Array.from({ length: Math.min(count, 4) }, (_, index) => (
        <div key={index} aria-hidden className="border-b border-border/40">
          <DiffFileHeaderSkeleton titleWidth="medium" />
        </div>
      ))}
    </div>
  );
}
