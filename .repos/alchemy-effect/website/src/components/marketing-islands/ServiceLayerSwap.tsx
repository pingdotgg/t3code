import { useEffect, useRef, useState, type ReactNode } from "react";
import { AWS_COLOR, CF_COLOR, tint } from "../marketing/diagrams/_colors";

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

type ResKind = "kv" | "ddb" | "d1";

interface Impl {
  layer: string; // Layer name shown in code
  resourceLabel: string; // node label
  resourceSub: string; // node sub-label
  bindCall: string; // bind call shown on the arrow
  color: string;
  kind: ResKind;
}

const D1_COLOR = "#0080FF";

const IMPLS: Impl[] = [
  {
    layer: "SessionsKV",
    resourceLabel: "Sessions",
    resourceSub: "Cloudflare.KVNamespace",
    bindCall: "KVNamespace.bind",
    color: CF_COLOR,
    kind: "kv",
  },
  {
    layer: "SessionsDynamoDB",
    resourceLabel: "Sessions",
    resourceSub: "AWS.DynamoDB.Table",
    bindCall: "DynamoDB.PutItem.bind",
    color: AWS_COLOR,
    kind: "ddb",
  },
  {
    layer: "SessionsD1",
    resourceLabel: "Sessions",
    resourceSub: "Cloudflare.D1Database",
    bindCall: "D1Database.bind",
    color: D1_COLOR,
    kind: "d1",
  },
];

const DWELL_MS = 2800;

function ResourceIcon({ kind, color }: { kind: ResKind; color: string }) {
  const fill = tint(color, 0.18);
  if (kind === "kv") {
    return (
      <svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden>
        <circle
          cx="11"
          cy="16"
          r="6"
          fill={fill}
          stroke={color}
          strokeWidth="1.5"
        />
        <circle cx="11" cy="16" r="2.2" fill={color} />
        <path
          d="M17 16 L27 16 M23 16 L23 21 M27 16 L27 12"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (kind === "ddb") {
    return (
      <svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden>
        <ellipse
          cx="16"
          cy="8"
          rx="10"
          ry="3"
          fill={fill}
          stroke={color}
          strokeWidth="1.4"
        />
        <ellipse
          cx="16"
          cy="16"
          rx="10"
          ry="3"
          fill={fill}
          stroke={color}
          strokeWidth="1.4"
        />
        <ellipse
          cx="16"
          cy="24"
          rx="10"
          ry="3"
          fill={fill}
          stroke={color}
          strokeWidth="1.4"
        />
      </svg>
    );
  }
  // d1
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden>
      <ellipse
        cx="16"
        cy="8"
        rx="10"
        ry="3"
        fill={fill}
        stroke={color}
        strokeWidth="1.5"
      />
      <path
        d="M6 8 V24 C6 25.7 10.5 27 16 27 C21.5 27 26 25.7 26 24 V8"
        fill={fill}
        stroke={color}
        strokeWidth="1.5"
      />
      <path
        d="M9 14 L23 14 M9 18 L23 18 M9 22 L19 22"
        stroke={color}
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function ServiceLayerSwap() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const tick = (i: number) => {
      if (cancelled) return;
      setIdx(i);
      if (reduced) return;
      timer = setTimeout(() => tick((i + 1) % IMPLS.length), DWELL_MS);
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

  const active = IMPLS[idx]!;

  return (
    <div ref={wrapRef} className="service-swap-grid">
      {/* LEFT — code: Worker that consumes Sessions, Layer name swaps */}
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
          <span className="alc-code-block__filename">src/Api.ts</span>
        </div>
        <pre className="alc-code-block__pre">
          <C>{"// Service interface — defined once."}</C>
          {"\n"}
          <K>export class</K> <T>Sessions</T> <K>extends</K> <V>Context</V>.
          <F>Service</F>
          {"<"}
          <T>Sessions</T>, {"{"}
          {"\n  "}
          <V>get</V>: (<V>id</V>: <T>string</T>) {"=>"} <V>Effect</V>.
          <T>Effect</T>
          {"<"}
          <T>Session</T>
          {">"};{"\n  "}
          <V>put</V>: (<V>s</V>: <T>Session</T>) {"=>"} <V>Effect</V>.
          <T>Effect</T>
          {"<"}
          <T>void</T>
          {">"};{"\n"}
          {"}>()("}
          <S>"Sessions"</S>
          {") {}"}
          {"\n\n"}
          <C>{"// Worker code never knows which Layer is providing it."}</C>
          {"\n"}
          <K>export default class</K> <T>Api</T> <K>extends</K>{" "}
          <V>Cloudflare</V>.<F>Worker</F>
          {"<"}
          <T>Api</T>
          {">()("}
          {"\n  "}
          <S>"Api"</S>,{"\n  "}
          <V>Effect</V>.<F>gen</F>(<K>function</K>* () {"{"}
          {"\n    "}
          <K>const</K> sessions = <K>yield</K>* <V>Sessions</V>;{"\n    "}
          <K>return</K> {"{ fetch: handler(sessions) };"}
          {"\n  "}
          {"}).pipe("}
          {"\n    "}
          <C>
            {"// Swap one Layer — resources, bindings, IAM all swap with it."}
          </C>
          {"\n    "}
          <V>Effect</V>.<F>provide</F>(
          <span
            key={idx}
            className="layer-swap"
            style={{ color: active.color, fontWeight: 600 }}
          >
            {active.layer}
          </span>
          ),
          {"\n  "}
          {"),"}
          {"\n"}
          {") {}"}
        </pre>
      </div>

      {/* RIGHT — visual: Sessions → Layer → Resource */}
      <div className="service-swap-stage">
        <div className="service-swap-stage__node service-swap-stage__node--accent">
          <svg
            width="22"
            height="22"
            viewBox="0 0 32 32"
            fill="none"
            aria-hidden
          >
            <rect
              x="4"
              y="6"
              width="24"
              height="20"
              rx="4"
              fill="rgba(184,138,74,0.15)"
              stroke="var(--alc-accent-deep)"
              strokeWidth="1.5"
            />
            <path
              d="M9 13 H23 M9 17 H19 M9 21 H21"
              stroke="var(--alc-accent-deep)"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          <div className="service-swap-stage__label">Sessions</div>
          <div className="service-swap-stage__sub">Context.Service</div>
        </div>

        <div
          className="service-swap-stage__edge service-swap-stage__edge--down"
          style={{ borderColor: active.color }}
        >
          <span
            className="service-swap-stage__edge-label"
            style={{ color: active.color, borderColor: active.color }}
          >
            Layer.effect
          </span>
        </div>

        <div
          key={`layer-${idx}`}
          className="service-swap-stage__node layer-swap-node"
          style={{
            borderColor: active.color,
            boxShadow: `0 0 0 2px ${tint(active.color, 0.12)}`,
          }}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 32 32"
            fill="none"
            aria-hidden
          >
            <path
              d="M16 4 L28 10 L16 16 L4 10 Z"
              fill={tint(active.color, 0.18)}
              stroke={active.color}
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
            <path
              d="M4 16 L16 22 L28 16"
              stroke={active.color}
              strokeWidth="1.4"
              fill="none"
              strokeLinejoin="round"
              opacity="0.85"
            />
            <path
              d="M4 22 L16 28 L28 22"
              stroke={active.color}
              strokeWidth="1.4"
              fill="none"
              strokeLinejoin="round"
              opacity="0.55"
            />
          </svg>
          <div
            className="service-swap-stage__label"
            style={{ color: active.color }}
          >
            {active.layer}
          </div>
          <div className="service-swap-stage__sub">Layer</div>
        </div>

        <div
          className="service-swap-stage__edge service-swap-stage__edge--down"
          style={{ borderColor: active.color }}
        >
          <span
            className="service-swap-stage__edge-label"
            style={{ color: active.color, borderColor: active.color }}
          >
            {active.bindCall}
          </span>
        </div>

        <div
          key={`res-${idx}`}
          className="service-swap-stage__node layer-swap-node"
          style={{ borderColor: active.color }}
        >
          <ResourceIcon kind={active.kind} color={active.color} />
          <div className="service-swap-stage__label">
            {active.resourceLabel}
          </div>
          <div className="service-swap-stage__sub">{active.resourceSub}</div>
        </div>

        <div className="service-swap-stage__steps" aria-hidden>
          {IMPLS.map((_, i) => (
            <span
              key={i}
              className={`service-swap-stage__dot${i === idx ? " is-active" : ""}`}
              style={i === idx ? { background: active.color } : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
