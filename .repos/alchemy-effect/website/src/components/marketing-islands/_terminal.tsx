import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Pauses of at least this long are a demo holding a finished frame. */
const HOLD_MS = 2000;

/** Set by the page's "Pause motion" control (WCAG 2.2.2). */
const isMotionPaused = () =>
  typeof document !== "undefined" &&
  document.documentElement.classList.contains("alc-motion-paused");

/** A wait that stops while motion is paused and resumes where it left off. */
const pausableWait = (ms: number) =>
  new Promise<void>((resolve) => {
    let left = ms;
    let since = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        left -= performance.now() - since;
      }
      if (isMotionPaused()) return;
      since = performance.now();
      timer = setTimeout(() => {
        removeEventListener("alc-motion-change", sync);
        resolve();
      }, left);
    };
    addEventListener("alc-motion-change", sync);
    sync();
  });

/**
 * Timeline pause for the scripted terminal demos. With reduced motion the
 * script fast-forwards to its first finished frame and stays there: short
 * steps resolve immediately and the first hold never resolves, so a loop
 * must reach a hold or stop on its own or it never yields and freezes the
 * tab. Otherwise the wait honors the page's pause control.
 */
export const sleep = (ms: number): Promise<void> =>
  prefersReducedMotion()
    ? ms >= HOLD_MS
      ? new Promise<void>(() => {})
      : Promise.resolve()
    : pausableWait(ms);

export function useSpinner(active: boolean, intervalMs = 80): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active || prefersReducedMotion()) return;
    const t = setInterval(() => setI((v) => (v + 1) % SPINNER_FRAMES.length), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return SPINNER_FRAMES[i]!;
}

/** Run an async loop only once the element scrolls into view, and stop when it leaves. */
export function useInViewLoop(
  ref: React.RefObject<HTMLElement | null>,
  run: (signal: { aborted: boolean }) => void | Promise<void>,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const signal = { aborted: false };
    let started = false;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !started) {
            started = true;
            void run(signal);
            obs.disconnect();
          }
        }
      },
      { threshold: 0.2 },
    );
    obs.observe(el);
    return () => {
      signal.aborted = true;
      obs.disconnect();
    };
  }, []);
}

export function TermChrome({
  title,
  badge,
  badgeColor,
  children,
  bodyMinHeight,
  maxLines,
  bare,
}: {
  title: string;
  badge?: string;
  badgeColor?: string;
  children: ReactNode;
  bodyMinHeight?: number;
  /**
   * Locks the terminal body to exactly this many lines of content (computed
   * from the body font-size × line-height + padding). Use in docs/embedded
   * contexts where layout shift below the terminal must be avoided. Count
   * the maximum number of visible lines the body ever renders. Takes
   * precedence over `bodyMinHeight`.
   */
  maxLines?: number;
  /**
   * When true, omit the outer `.alc-term` wrapper and the dots/title header.
   * Useful when this terminal is embedded inside another chrome (e.g. the
   * mobile tab toggle that combines code + deploy into one card).
   */
  bare?: boolean;
}) {
  // `1lh` resolves to the computed line-height of `.alc-term__body`, so the
  // reservation scales with font-size and browser zoom. Padding (28px = 14px
  // top + 14px bottom) is fixed visual chrome; with `box-sizing: border-box`
  // it's included in `height`.
  const bodyStyle: CSSProperties | undefined =
    maxLines !== undefined
      ? {
          boxSizing: "border-box",
          height: `calc(${maxLines} * 1lh + 28px)`,
          minHeight: `calc(${maxLines} * 1lh + 28px)`,
          overflow: "hidden",
        }
      : bodyMinHeight
        ? { minHeight: bodyMinHeight }
        : undefined;
  if (bare) {
    return (
      <pre className="alc-term__body" style={bodyStyle}>
        {children}
      </pre>
    );
  }
  return (
    // `data-nosnippet`: the simulated terminal is decoration, not prose. Left
    // visible to crawlers it leaks into Google-generated snippets as chrome
    // fragments ("~/my-appDEV", "○localhost:1337/ HMR").
    <div className="alc-term not-content" data-nosnippet="">
      <div className="alc-term__header">
        <span className="alc-code-block__dot" style={{ background: "var(--alc-dot-red)" }} />
        <span className="alc-code-block__dot" style={{ background: "var(--alc-dot-yellow)" }} />
        <span className="alc-code-block__dot" style={{ background: "var(--alc-dot-green)" }} />
        <span className="alc-term__title">{title}</span>
        <span style={{ flex: 1 }} />
        {badge && badgeColor && (
          <span
            style={{
              fontFamily: "var(--alc-font-mono)",
              fontSize: 10,
              letterSpacing: "0.14em",
              fontWeight: 700,
              padding: "2px 8px",
              borderRadius: 4,
              color: badgeColor,
              border: `1px solid ${badgeColor}`,
              background: "transparent",
              transition: "color 280ms ease, border-color 280ms ease",
            }}
          >
            {badge}
          </span>
        )}
      </div>
      <pre className="alc-term__body" style={bodyStyle}>
        {children}
      </pre>
    </div>
  );
}

export function Line({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return <div style={{ minHeight: "1.55em", whiteSpace: "pre", ...style }}>{children}</div>;
}
