import { useEffect, useRef, useState } from "react";
import { highlightTS } from "../marketing/highlightTS";

interface Panel {
  filename: string;
  code: string;
  caption: string;
}

const DWELL_MS = 5000;

export default function AsyncTabs({ panels }: { panels: Panel[] }) {
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      timer = setTimeout(() => {
        if (cancelled) return;
        setActive((i) => (i + 1) % panels.length);
      }, DWELL_MS);
    };

    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            schedule();
          } else if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        }
      },
      { threshold: 0.3 },
    );
    if (wrapRef.current) obs.observe(wrapRef.current);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      obs.disconnect();
    };
  }, [active, panels.length]);

  const html = panels.map((p) => highlightTS(p.code));

  return (
    <div ref={wrapRef} className="async-tabs">
      <div className="async-tabs__chrome">
        <div className="async-tabs__header">
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
          <div className="async-tabs__tabs" role="tablist">
            {panels.map((p, i) => (
              <button
                key={p.filename}
                type="button"
                role="tab"
                aria-selected={active === i}
                data-active={active === i}
                className="async-tabs__tab"
                onClick={() => setActive(i)}
              >
                {p.filename}
              </button>
            ))}
          </div>
        </div>
        <div className="async-tabs__body">
          {panels.map((p, i) => (
            <div
              key={p.filename}
              className="async-tabs__panel"
              hidden={active !== i}
            >
              <pre
                className="alc-code-block__pre async-tabs__pre"
                dangerouslySetInnerHTML={{ __html: html[i] }}
              />
            </div>
          ))}
        </div>
      </div>
      <div key={active} className="alc-code-block__caption" aria-live="polite">
        {panels[active].caption}
      </div>
    </div>
  );
}
