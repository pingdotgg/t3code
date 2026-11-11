/* oxlint-disable react/no-array-index-key -- A page keeps its ordinal throughout incremental layout. */
import { observeResize } from "~/lib/observeResize";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

export type PageSize = {
  readonly width: number;
  readonly height: number;
  readonly background?: string | undefined;
};
export type PaintPage = (
  index: number,
  canvas: HTMLCanvasElement,
  scale: number,
  signal: AbortSignal,
) => Promise<void>;

export function OfficePages(props: {
  pages: readonly PageSize[];
  paint: PaintPage;
  label: string;
  overlay?: (index: number) => ReactNode;
  footer?: (index: number) => ReactNode;
  scrollRef?: RefObject<((index: number, y?: number) => void) | null>;
  onPageChange?: (index: number) => void;
  onError: (error: unknown) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<number, HTMLDivElement>());
  const [width, setWidth] = useState(0);
  const [settledWidth, setSettledWidth] = useState(0);
  const [mounted, setMounted] = useState(6);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe the scroll container width and debounce raster resizing, releasing the observer and timer on unmount.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout>;
    const unobserve = observeResize(root, ([entry]) => {
      if (!entry) return;
      const next = entry.contentRect.width;
      setWidth(next);
      clearTimeout(timer);
      timer = setTimeout(() => setSettledWidth(next), 150);
    });
    return () => {
      clearTimeout(timer);
      unobserve();
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Yield between page mounting batches with a timer so large documents do not block the browser.
  useEffect(() => {
    if (mounted >= props.pages.length) return;
    const timer = setTimeout(() => setMounted((n) => Math.min(props.pages.length, n + 50)), 0);
    return () => clearTimeout(timer);
  }, [mounted, props.pages.length]);
  useImperativeHandle(
    props.scrollRef,
    () =>
      (index: number, y = 0) => {
        const row = rows.current.get(index);
        const page = props.pages[index];
        if (row && page)
          scroller.current?.scrollTo({
            top: row.offsetTop + y * Math.min(1, Math.max(0, width - 48) / page.width) - 24,
          });
      },
    [props.pages, width],
  );
  return (
    <div
      ref={scroller}
      className="relative min-h-0 flex-1 overflow-auto bg-muted/60"
      data-office-pages
      onScroll={() => {
        const root = scroller.current;
        if (!root || !props.onPageChange) return;
        if (
          root.scrollHeight > root.clientHeight &&
          root.scrollTop + root.clientHeight >= root.scrollHeight - 1
        ) {
          props.onPageChange(Math.min(mounted, props.pages.length) - 1);
          return;
        }
        for (const [index, row] of [...rows.current].sort(([a], [b]) => a - b)) {
          if (row.offsetTop + row.offsetHeight > root.scrollTop + 24) {
            props.onPageChange(index);
            break;
          }
        }
      }}
    >
      <div className="flex flex-col items-center gap-4 py-6">
        {props.pages.slice(0, mounted).map((page, index) => (
          <OfficePage
            key={index}
            page={page}
            index={index}
            root={scroller}
            register={(el) => {
              if (el) rows.current.set(index, el);
              else rows.current.delete(index);
            }}
            scale={Math.min(1, Math.max(0, width - 48) / page.width)}
            rasterScale={Math.min(1, Math.max(0, (settledWidth || width) - 48) / page.width)}
            {...props}
          />
        ))}
      </div>
    </div>
  );
}

function OfficePage(props: {
  page: PageSize;
  index: number;
  root: RefObject<HTMLDivElement | null>;
  register: (element: HTMLDivElement | null) => void;
  scale: number;
  rasterScale: number;
  paint: PaintPage;
  label: string;
  overlay?: (index: number) => ReactNode;
  footer?: (index: number) => ReactNode;
  onError: (error: unknown) => void;
}) {
  const {
    root,
    rasterScale,
    index,
    onError,
    page,
    paint,
    scale,
    register,
    label,
    overlay,
    footer,
  } = props;
  const row = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [ratio, setRatio] = useState(window.devicePixelRatio || 1);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Observe the page's viewport proximity to limit painting and text layers to nearby pages.
  useEffect(() => {
    if (!row.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry?.isIntersecting ?? false),
      { root: root.current, rootMargin: "100% 0px" },
    );
    observer.observe(row.current);
    return () => observer.disconnect();
  }, [root]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to display density changes so canvas rasters match the current screen.
  useEffect(() => {
    const query = matchMedia(`(resolution: ${ratio}dppx)`);
    const change = () => setRatio(window.devicePixelRatio || 1);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, [ratio]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Paint the visible page canvas at the current raster scale and cancel obsolete paint requests.
  useEffect(() => {
    const target = canvas.current;
    if (!target || !page || !near || ratio <= 0 || rasterScale <= 0) return;
    const controller = new AbortController();
    void paint(index, target, rasterScale, controller.signal).catch((cause: unknown) => {
      if (!controller.signal.aborted) onError(cause);
    });
    return () => controller.abort();
  }, [near, index, page, paint, rasterScale, onError, ratio]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release the canvas backing store when its page moves away from the viewport.
  useEffect(() => {
    const target = canvas.current;
    if (!near && target) {
      target.width = 0;
      target.height = 0;
    }
  }, [near]);
  return (
    <div className="flex shrink-0 flex-col gap-3" style={{ width: page.width * scale }}>
      <div
        ref={(el) => {
          row.current = el;
          register(el);
        }}
        role="group"
        aria-label={`${label} ${index + 1}`}
        className="relative shrink-0 shadow-md"
        style={{
          width: page.width * scale,
          height: page.height * scale,
          background: page.background ?? "#fff",
        }}
      >
        <canvas ref={canvas} aria-hidden="true" className="absolute inset-0 block size-full" />
        {near ? overlay?.(index) : null}
      </div>
      {footer?.(index)}
    </div>
  );
}
