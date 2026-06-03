import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useSpinner(active: boolean, intervalMs = 80): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(
      () => setI((v) => (v + 1) % SPINNER_FRAMES.length),
      intervalMs,
    );
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <div className="alc-term not-content">
      <div className="alc-term__header">
        <span
          className="alc-code-block__dot"
          style={{ background: "var(--alc-danger)" }}
        />
        <span
          className="alc-code-block__dot"
          style={{ background: "var(--alc-warn)" }}
        />
        <span
          className="alc-code-block__dot"
          style={{ background: "var(--alc-accent-bright)" }}
        />
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

export function Line({
  children,
  style,
}: {
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div style={{ minHeight: "1.55em", whiteSpace: "pre", ...style }}>
      {children}
    </div>
  );
}
