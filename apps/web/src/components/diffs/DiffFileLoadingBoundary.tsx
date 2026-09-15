import { useEffect, useRef, useState } from "react";
import { DiffFileHeaderSkeleton } from "../DiffPanelShell";

/** Fetch ahead of the bottom edge without displaying empty file headers. */
export function DiffFileLoadingBoundary({ load, count }: { load: () => void; count: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [rowWindow, setWindow] = useState({ start: 0, size: 50, rowHeight: 33 });
  // Retain one row's scroll space per file without mounting thousands of skeletons.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rowHeight = element.firstElementChild?.getBoundingClientRect().height || 33;
      const start = Math.max(0, Math.floor(-element.getBoundingClientRect().top / rowHeight) - 10);
      const size = Math.ceil(globalThis.innerHeight / rowHeight) + 20;
      setWindow((previous) =>
        previous.start === start && previous.size === size && previous.rowHeight === rowHeight
          ? previous
          : { start, size, rowHeight },
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const scrollRoot = element.getRootNode();
    scrollRoot.addEventListener("scroll", schedule, { capture: true, passive: true });
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    globalThis.addEventListener("resize", schedule);
    measure();
    return () => {
      resize.disconnect();
      scrollRoot.removeEventListener("scroll", schedule, true);
      document.removeEventListener("scroll", schedule, true);
      globalThis.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, []);
  const start = Math.min(rowWindow.start, Math.max(0, count - rowWindow.size));
  const visibleCount = Math.min(count - start, rowWindow.size);
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
    <div
      ref={ref}
      role="status"
      aria-label="Loading diff…"
      style={{
        paddingTop: start * rowWindow.rowHeight,
        paddingBottom: (count - start - visibleCount) * rowWindow.rowHeight,
      }}
    >
      {Array.from({ length: visibleCount }, (_, index) => (
        <div key={index} aria-hidden className="border-b border-border/40">
          <DiffFileHeaderSkeleton titleClassName="w-1/2 max-w-64" />
        </div>
      ))}
    </div>
  );
}
