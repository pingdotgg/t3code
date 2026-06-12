import { useEffect, useRef, useState, type ReactNode } from "react";
import { tint } from "../marketing/diagrams/_colors";

const ACCENT = "var(--alc-accent-deep)";
const ACCENT_TINT = tint("#B88A4A", 0.18);

const tok =
  (color: string) =>
  ({ children }: { children: ReactNode }) => (
    <span style={{ color }}>{children}</span>
  );
const K = tok("var(--alc-code-keyword)");
const S = tok("var(--alc-code-string)");
const F = tok("var(--alc-code-fn)");
const V = tok("var(--alc-code-var)");
const T = tok("var(--alc-code-type)");
const C = ({ children }: { children: ReactNode }) => (
  <span style={{ color: "var(--alc-code-comment)", fontStyle: "italic" }}>
    {children}
  </span>
);

interface Step {
  annotation: ReactNode;
  show: { distribution: boolean; map: boolean; interpolate: boolean };
}

const STEPS: Step[] = [
  {
    annotation: (
      <>
        A resource produces typed <strong>Output</strong> attributes — lazy
        references that resolve after deploy.
      </>
    ),
    show: { distribution: false, map: false, interpolate: false },
  },
  {
    annotation: (
      <>
        Pass an Output as input to another resource. Alchemy draws the
        dependency edge and deploys <strong>Photos</strong> first.
      </>
    ),
    show: { distribution: true, map: false, interpolate: false },
  },
  {
    annotation: (
      <>
        <code>Output.map</code> composes lazily — the function runs only when
        the upstream Output resolves.
      </>
    ),
    show: { distribution: true, map: true, interpolate: false },
  },
  {
    annotation: (
      <>
        <code>Output.interpolate</code> splices Outputs into template strings —
        same lazy graph, ergonomic syntax.
      </>
    ),
    show: { distribution: true, map: true, interpolate: true },
  },
];

const STEP_DWELL = [2400, 2800, 2800, 3200];

export default function OutputGraphAnim() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const tick = (i: number) => {
      if (cancelled) return;
      setStep(i);
      if (reduced) {
        setStep(STEPS.length - 1);
        return;
      }
      timer = setTimeout(() => tick((i + 1) % STEPS.length), STEP_DWELL[i]);
    };

    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            tick(0);
            obs.disconnect();
          }
        }
      },
      { threshold: 0.25 },
    );
    if (wrapRef.current) obs.observe(wrapRef.current);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      obs.disconnect();
    };
  }, []);

  const s = STEPS[step]!;

  // Highlight wrapper for code spans active in the current step.
  const Hl = ({
    active,
    children,
  }: {
    active: boolean;
    children: ReactNode;
  }) => (
    <span
      style={{
        background: active ? ACCENT_TINT : "transparent",
        boxShadow: active ? `0 0 0 1px ${tint("#B88A4A", 0.4)}` : "none",
        borderRadius: 4,
        padding: "1px 4px",
        margin: "0 -4px",
        transition: "background 320ms ease, box-shadow 320ms ease",
      }}
    >
      {children}
    </span>
  );

  return (
    <div ref={wrapRef} className="output-anim-grid">
      {/* LEFT — code panel with progressive highlight */}
      <div className="alc-code-block">
        <div className="alc-code-block__header">
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
          <span className="alc-code-block__filename">alchemy.run.ts</span>
        </div>
        <pre className="alc-code-block__pre">
          <Hl active={step === 0}>
            <K>const</K> bucket = <K>yield</K>* <V>Cloudflare</V>.
            <F>R2Bucket</F>(<S>"Photos"</S>);
            {"\n"}
            bucket.<V>bucketName</V>; <C>{"// Output<string>"}</C>
          </Hl>
          {"\n\n"}
          <Hl active={step === 1}>
            <K>const</K> dist = <K>yield</K>* <V>CloudFront</V>.
            <F>Distribution</F>(<S>"CDN"</S>, {"{"}
            {"\n  "}
            <V>origin</V>: bucket.<V>bucketName</V>,{"\n"}
            {"});"}
          </Hl>
          {"\n\n"}
          <Hl active={step === 2}>
            <K>const</K> homepage = dist.<V>domainName</V>.<F>pipe</F>({"\n  "}
            <V>Output</V>.<F>map</F>((d) {"=>"} <S>{"`https://${d}`"}</S>),
            {"\n"}
            {");"}
          </Hl>
          {"\n\n"}
          <Hl active={step === 3}>
            <K>const</K> banner = <V>Output</V>.<F>interpolate</F>
            <S>{"`served from ${dist.domainName}`"}</S>;
          </Hl>
        </pre>
      </div>

      {/* RIGHT — progressive diagram + annotation */}
      <div className="output-anim-stage">
        <div className="output-anim-graph" aria-hidden>
          {/* Row 1 */}
          <div className="output-anim-node output-anim-node--accent">
            <div className="output-anim-node__label">R2Bucket</div>
            <div className="output-anim-node__id">"Photos"</div>
          </div>

          <Edge dir="h" visible={s.show.distribution} label="bucketName" />

          <div
            className="output-anim-node output-anim-node--accent"
            style={{
              opacity: s.show.distribution ? 1 : 0.15,
              transform: s.show.distribution ? "scale(1)" : "scale(0.92)",
              transition: "opacity 380ms ease, transform 380ms ease",
            }}
          >
            <div className="output-anim-node__label">Distribution</div>
            <div className="output-anim-node__id">"CDN"</div>
          </div>

          {/* Row 2 (vertical edge under Distribution) */}
          <div />
          <div />
          <Edge dir="v" visible={s.show.map} label="domainName" />

          {/* Row 3 (Output.map under Distribution) */}
          <div />
          <div />
          <div
            className="output-anim-node output-anim-node--ghost"
            style={{
              opacity: s.show.map ? 1 : 0.15,
              transform: s.show.map ? "scale(1)" : "scale(0.92)",
              transition: "opacity 380ms ease, transform 380ms ease",
            }}
          >
            <div className="output-anim-node__label">Output.map</div>
            <div className="output-anim-node__id">homepage</div>
          </div>
        </div>

        <div className="output-anim-steps" aria-hidden>
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`output-anim-steps__dot${i === step ? " is-active" : ""}`}
            />
          ))}
        </div>

        <div className="output-anim-annotation">{s.annotation}</div>
      </div>
    </div>
  );
}

function Edge({
  dir,
  visible,
  label,
}: {
  dir: "h" | "v";
  visible: boolean;
  label: string;
}) {
  return (
    <div
      className={`output-anim-edge output-anim-edge--${dir}${visible ? " is-on" : ""}`}
    >
      <span className="output-anim-edge__label">{label}</span>
    </div>
  );
}
