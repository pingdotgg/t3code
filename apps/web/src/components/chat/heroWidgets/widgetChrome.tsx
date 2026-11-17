import type { LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

export const GHOST = "color-mix(in oklab, var(--foreground) 8%, transparent)";
export const FAINT = "color-mix(in oklab, var(--foreground) 4%, transparent)";

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer that keeps the widgets' clocks current
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useElementSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks the element's size for pixel-placed labels
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSize((previous) =>
        previous.width === Math.round(rect.width) && previous.height === Math.round(rect.height)
          ? previous
          : { width: Math.round(rect.width), height: Math.round(rect.height) },
      );
    };
    measure();
    return observeResize(element, measure);
  }, [ref]);
  return size;
}

export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is a convenience; the widgets still render without it.
  }
}

export function WidgetCard({
  id,
  icon: Icon,
  title,
  meta,
  metaTone,
  className,
  children,
}: {
  readonly id: string;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly meta?: ReactNode;
  readonly metaTone?: "warning" | undefined;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      data-hero-widget={id}
      className={cn(
        "flex h-full min-w-0 flex-col overflow-hidden rounded-xl border bg-card/85 p-4 text-card-foreground shadow-xs backdrop-blur-sm",
        className,
      )}
    >
      <header className="flex items-center gap-2 text-sm">
        <Icon className="size-4 shrink-0 opacity-80" aria-hidden />
        <h3 className="font-medium">{title}</h3>
        {meta ? (
          <span
            className={cn(
              "ms-auto truncate text-xs",
              metaTone === "warning" ? "text-warning" : "text-muted-foreground",
            )}
          >
            {meta}
          </span>
        ) : null}
      </header>
      {children}
    </section>
  );
}

export const WEEKDAY_TIME = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});
export const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** Throwaway: exposes widget inputs on window.__heroWidgets for the screenshot script. */
export function useDebugValue(key: string, value: unknown) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the latest widget inputs for inspection
  useEffect(() => {
    const target = window as unknown as { __heroWidgets?: Record<string, unknown> };
    target.__heroWidgets = { ...target.__heroWidgets, [key]: value };
  });
}
