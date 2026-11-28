import { useEffect, useState } from "react";
import { highlightTS } from "../marketing/highlightTS";
import "./ObservabilityDash.css";

/*
 * The observability section: the Observability Layer on the left, and a
 * small window on the right with what its resources produce. Traces arrive,
 * errors spike past the monitor's threshold, the monitor fires and the
 * alert goes to the agent, then it recovers. The Layer's code lights the
 * line that created whatever is changing.
 */

const LAYER_SRC = `export const Observability = Layer.unwrap(
  Effect.gen(function* () {
    const traces = yield* Axiom.Dataset("Traces", tracesProps);
    const logs = yield* Axiom.Dataset("Logs", logsProps);
    const token = yield* Axiom.ApiToken("Ingest", ingestProps);

    yield* Axiom.Dashboard("Dashboard", dashboardProps);
    yield* Axiom.Monitor("Errors", errorRateProps);

    return Axiom.Telemetry({ token, traces, logs });
  }),
);`;

// 0-based lines of LAYER_SRC lit in each phase.
const LIT = {
  traces: [2, 3, 4, 9],
  dashboard: [6],
  monitor: [7],
} as const;

const T_DASH = 2600;
const T_SPIKE = 4400;
const T_ALERT = 5600;
const T_RECOVER = 8800;
const LOOP_MS = 10400;
const TICK_MS = 260;
const POINTS = 36;
const THRESHOLD = 10;

const noise = (i: number, seed: number) => {
  const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
};
const err = (i: number, spikeFrom: number) =>
  i >= spikeFrom ? Math.min(28, 13 + 9 * noise(i, 3) + (i - spikeFrom) * 1.5) : 1.5 * noise(i, 2);

const TRACES: [string, number][] = [
  ["PUT /photos/cat.jpg", 48],
  ["GET /photos", 12],
  ["PUT /photos/dog.png", 52],
  ["GET /photos/cat.jpg", 9],
];

const isPaused = () =>
  document.documentElement.classList.contains("alc-motion-paused") ||
  matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function ObservabilityDash() {
  // A still frame (the monitor firing) until the loop starts.
  const [t, setT] = useState(T_ALERT + 600);

  useEffect(() => {
    let paused = isPaused();
    let last = performance.now();
    let elapsed = 0;
    const onMotion = () => {
      paused = isPaused();
    };
    addEventListener("alc-motion-change", onMotion);
    const id = setInterval(() => {
      const now = performance.now();
      if (!paused) {
        elapsed = (elapsed + now - last) % LOOP_MS;
        setT(elapsed);
      }
      last = now;
    }, 80);
    return () => {
      clearInterval(id);
      removeEventListener("alc-motion-change", onMotion);
    };
  }, []);

  const tick = Math.floor(t / TICK_MS);
  const spiking = t >= T_SPIKE && t < T_RECOVER;
  const alerting = t >= T_ALERT && t < T_RECOVER;
  // The spike enters at the right edge and scrolls left.
  const spikeFrom = spiking ? tick + POINTS - Math.floor((t - T_SPIKE) / TICK_MS) - 1 : Infinity;
  const errors = Array.from({ length: POINTS }, (_, k) => err(tick + k, spikeFrom));
  const phase = t < T_DASH ? "traces" : t < T_ALERT ? "dashboard" : "monitor";
  const traceCount = Math.min(TRACES.length, 1 + Math.floor(t / 500));

  const W = 300;
  const H = 64;
  const MAX = 30;
  const px = (i: number) => (i / (POINTS - 1)) * W;
  const py = (v: number) => H - (v / MAX) * H;
  const d = errors
    .map((v, i) => `${i ? "L" : "M"}${px(i).toFixed(1)} ${py(v).toFixed(1)}`)
    .join(" ");

  return (
    <div className="od" aria-hidden>
      <div className="od-code">
        <div className="od-bar">
          <span className="od-bar__file">src/Observability.ts</span>
        </div>
        <pre className="od-code__pre">
          {LAYER_SRC.split("\n").map((line, i) => (
            <span
              key={i}
              className={`od-line ${(LIT[phase] as readonly number[]).includes(i) ? "is-lit" : ""}`}
              dangerouslySetInnerHTML={{ __html: highlightTS(line) || " " }}
            />
          ))}
        </pre>
      </div>

      <div className="od-win">
        <div className="od-bar">
          <span className="od-dot" style={{ background: "var(--alc-dot-red)" }} />
          <span className="od-dot" style={{ background: "var(--alc-dot-yellow)" }} />
          <span className="od-dot" style={{ background: "var(--alc-dot-green)" }} />
          <span className="od-bar__file">axiom · my-app</span>
          <span className={`od-badge ${alerting ? "is-red" : ""}`}>
            {alerting ? "ALERTING" : "OK"}
          </span>
        </div>
        <div className="od-win__body">
          <div className={`od-block ${phase === "dashboard" ? "is-focus" : ""}`}>
            <div className="od-label">
              <span>errors / min</span>
              <span className={alerting ? "od-red" : "od-muted"}>
                {Math.round(errors[POINTS - 1]!)}
              </span>
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="od-chart">
              <line x1={0} x2={W} y1={py(THRESHOLD)} y2={py(THRESHOLD)} className="od-threshold" />
              <path d={`${d} L${W} ${H} L0 ${H} Z`} className="od-area" />
              <path d={d} className="od-path" />
            </svg>
          </div>

          <ul className={`od-traces ${phase === "traces" ? "is-focus" : ""}`}>
            {TRACES.slice(0, traceCount).map(([name, ms]) => {
              const failed = spiking && name.startsWith("PUT");
              return (
                <li key={name} className={failed ? "is-failed" : ""}>
                  <span className="od-traces__mark">{failed ? "✗" : "✓"}</span>
                  <span className="od-traces__name">{name}</span>
                  <span className="od-traces__ms">{failed ? "500" : `${ms}ms`}</span>
                </li>
              );
            })}
          </ul>

          <div className={`od-monitor ${alerting ? "is-red" : ""}`}>
            <span className="od-monitor__dot" />
            <span>Photos errors</span>
            <span className="od-muted">count(error) &gt; {THRESHOLD}</span>
          </div>
          <div className={`od-alert ${alerting ? "is-shown" : ""}`}>
            <span className="od-red">✗</span> monitor fired → sent to the agent: Photos.upload
            failing
          </div>
        </div>
      </div>
    </div>
  );
}
