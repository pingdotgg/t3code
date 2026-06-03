import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";

const tok =
  (color: string) =>
  ({ children }: { children: ReactNode }) => (
    <span style={{ color }}>{children}</span>
  );
const K = tok("var(--alc-code-keyword)");
const S = tok("var(--alc-code-string)");
const F = tok("var(--alc-code-fn)");
const T = tok("var(--alc-code-type)");
const V = tok("var(--alc-code-var)");
const C = ({ children }: { children: ReactNode }) => (
  <span style={{ color: "var(--alc-code-comment)", fontStyle: "italic" }}>
    {children}
  </span>
);

interface BindRow {
  id: string;
  call: ReactNode;
  resource: {
    label: string;
    sub: string;
    kind: "s3" | "ddb" | "ddb-stream" | "sqs";
  };
  arrow: { kind: "iam" | "stream"; label: string };
}

const ROWS: BindRow[] = [
  {
    id: "get",
    call: (
      <>
        <K>const</K> getPhoto = <K>yield</K>* <V>S3</V>.<V>GetObject</V>.
        <F>bind</F>(<T>Photos</T>);
      </>
    ),
    resource: { label: "Photos", sub: "S3.Bucket", kind: "s3" },
    arrow: { kind: "iam", label: "Allow s3:GetObject" },
  },
  {
    id: "put",
    call: (
      <>
        <K>const</K> putJob = <K>yield</K>* <V>DynamoDB</V>.<V>PutItem</V>.
        <F>bind</F>(<T>Jobs</T>);
      </>
    ),
    resource: { label: "Jobs", sub: "DynamoDB.Table", kind: "ddb" },
    arrow: { kind: "iam", label: "Allow dynamodb:PutItem" },
  },
  {
    id: "stream",
    call: (
      <>
        <K>yield</K>* <V>DynamoDB</V>.<F>stream</F>(<T>Jobs</T>).<F>process</F>
        (handler);
      </>
    ),
    resource: {
      label: "Jobs.stream",
      sub: "EventSourceMapping",
      kind: "ddb-stream",
    },
    arrow: { kind: "stream", label: "EventSource" },
  },
];

function ResourceIcon({ kind }: { kind: BindRow["resource"]["kind"] }) {
  const icon =
    kind === "s3"
      ? "logos:aws-s3"
      : kind === "ddb"
        ? "logos:aws-dynamodb"
        : kind === "ddb-stream"
          ? "logos:aws-lambda"
          : "logos:aws-sqs";
  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        overflow: "hidden",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <Icon icon={icon} width={28} height={28} aria-hidden />
    </div>
  );
}

export default function BindingsToIAM() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const cycle = (i: number) => {
      if (cancelled) return;
      setActive(i);
      if (reduced) {
        setActive(ROWS.length - 1);
        return;
      }
      const next = (i + 1) % (ROWS.length + 1); // +1 = "all visible" pause frame
      const dwell = i === ROWS.length - 1 ? 2200 : 1300;
      timer = setTimeout(() => cycle(next === ROWS.length ? -1 : next), dwell);
    };

    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            cycle(0);
            obs.disconnect();
          }
        }
      },
      { threshold: 0.2 },
    );
    if (wrapRef.current) obs.observe(wrapRef.current);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      obs.disconnect();
    };
  }, []);

  return (
    <div ref={wrapRef} className="bindings-iam">
      {/* LEFT — Lambda code */}
      <div className="alc-code-block bindings-iam__code">
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
          <span className="alc-code-block__filename">src/JobApi.ts</span>
        </div>
        <pre className="alc-code-block__pre">
          <K>export default</K> <V>AWS</V>.<V>Lambda</V>.<F>Function</F>
          {"("}
          {"\n  "}
          <S>"JobApi"</S>,{"\n  "}
          <V>Effect</V>.<F>gen</F>(<K>function</K>* () {"{"}
          {"\n    "}
          {ROWS.map((r, i) => (
            <span key={r.id}>
              <span
                data-row={r.id}
                className="bindings-iam__bind"
                style={{
                  padding: "1px 5px",
                  margin: "0 -5px",
                  borderRadius: 4,
                  background:
                    active === i ? "rgba(74, 110, 60, 0.22)" : "transparent",
                  boxShadow:
                    active === i ? "0 0 0 1px rgba(74, 110, 60, 0.55)" : "none",
                  transition: "background 280ms ease, box-shadow 280ms ease",
                }}
              >
                {r.call}
              </span>
              {"\n    "}
            </span>
          ))}
          {"\n    "}
          <K>return</K> {"{"}
          {"\n      "}
          <V>fetch</V>: (<V>req</V>) {"=>"} <V>Effect</V>.<F>gen</F>(
          <K>function</K>* () {"{"}
          {"\n        "}
          <K>const</K> photo = <K>yield</K>* <F>getPhoto</F>({"{ "}
          <V>key</V>: <V>req</V>.<V>key</V> {"}"});
          {"\n        "}
          <K>yield</K>* <F>putJob</F>({"{ "}
          <V>id</V>: <V>req</V>.<V>id</V>, <V>photo</V> {"}"});
          {"\n        "}
          <K>return</K> <K>new</K> <T>Response</T>(<S>"ok"</S>);
          {"\n      "}
          {"}),"}
          {"\n    "}
          {"};"}
          {"\n  "}
          {"}),"}
          {"\n"}
          {");"}
        </pre>
      </div>

      {/* MIDDLE — Animated arrows + labels */}
      <div className="bindings-iam__arrows" aria-hidden>
        <svg viewBox="0 0 200 280" preserveAspectRatio="none">
          <defs>
            <marker
              id="bia-arrow-active"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0 0 L8 4 L0 8 Z" fill="var(--alc-accent-deep)" />
            </marker>
            <marker
              id="bia-arrow-idle"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0 0 L8 4 L0 8 Z" fill="var(--alc-fg-3)" />
            </marker>
          </defs>
          {ROWS.map((r, i) => {
            const y = 50 + i * 90;
            const isActive = active === i;
            const stroke = isActive
              ? "var(--alc-accent-deep)"
              : "var(--alc-fg-3)";
            const marker = isActive
              ? "url(#bia-arrow-active)"
              : "url(#bia-arrow-idle)";
            return (
              <g
                key={r.id}
                opacity={isActive ? 1 : 0.55}
                style={{ transition: "opacity 320ms ease" }}
              >
                <path
                  d={`M 0 ${y} L 190 ${y}`}
                  stroke={stroke}
                  strokeWidth={isActive ? 1.8 : 1.1}
                  fill="none"
                  markerEnd={marker}
                  strokeDasharray={r.arrow.kind === "stream" ? "5 4" : "0"}
                  style={{
                    transition: "stroke 280ms ease, stroke-width 280ms ease",
                  }}
                />
                <text
                  x="100"
                  y={y - 8}
                  textAnchor="middle"
                  fontFamily="var(--alc-font-mono)"
                  fontSize="10"
                  fill={isActive ? "var(--alc-accent-deep)" : "var(--alc-fg-3)"}
                  style={{ transition: "fill 280ms ease" }}
                >
                  {r.arrow.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* RIGHT — Resources */}
      <div className="bindings-iam__resources">
        {ROWS.map((r, i) => {
          const isActive = active === i;
          return (
            <div
              key={r.id}
              className="bindings-iam__resource"
              style={{
                borderColor: isActive
                  ? "var(--alc-accent-deep)"
                  : "var(--alc-hairline)",
                boxShadow: isActive
                  ? "0 0 0 2px rgba(74, 110, 60, 0.18)"
                  : "none",
                transition: "border-color 280ms ease, box-shadow 280ms ease",
              }}
            >
              <ResourceIcon kind={r.resource.kind} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="bindings-iam__resource-label">
                  {r.resource.label}
                </div>
                <div className="bindings-iam__resource-sub">
                  {r.resource.sub}
                </div>
                <div
                  className="bindings-iam__resource-iam"
                  data-stream={r.arrow.kind === "stream" ? "true" : undefined}
                >
                  {r.arrow.kind === "stream" ? "↻" : "→"} {r.arrow.label}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
