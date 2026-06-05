import { useEffect, useRef, useState } from "react";
import { Line, sleep, TermChrome, useSpinner } from "./_terminal";

type Phase = "open" | "deploy" | "comment" | "observe" | "destroy";

const PHASES: { id: Phase; label: string }[] = [
  { id: "open", label: "PR opened" },
  { id: "deploy", label: "Deploy" },
  { id: "comment", label: "Comment" },
  { id: "observe", label: "Observe" },
  { id: "destroy", label: "Destroyed" },
];

const RESOURCES = [
  { id: "Photos", type: "Cloudflare.R2Bucket" },
  { id: "Sessions", type: "Cloudflare.KVNamespace" },
  { id: "Api", type: "Cloudflare.Worker" },
];

const PR_NUMBER = 147;
const STAGE = `pr-${PR_NUMBER}`;
const PREVIEW_URL = `https://${STAGE}.api.example.workers.dev`;

export default function PRLifecycle() {
  const [phase, setPhase] = useState<Phase>("open");
  const [cmd, setCmd] = useState("");
  const [caret, setCaret] = useState(false);
  const [rows, setRows] = useState<
    {
      id: string;
      type: string;
      status: "ready" | "creating" | "created" | "deleting" | "deleted";
    }[]
  >([]);
  const [done, setDone] = useState<{ verb: string; secs: string } | null>(null);

  const cancelRef = useRef(false);

  useEffect(() => {
    cancelRef.current = false;
    const aborted = () => cancelRef.current;

    const typeCmd = async (text: string) => {
      setCmd("");
      setCaret(true);
      for (let i = 1; i <= text.length; i++) {
        if (aborted()) return;
        setCmd(text.slice(0, i));
        await sleep(28 + Math.random() * 22);
      }
      await sleep(140);
      setCaret(false);
    };

    const updateRow = (id: string, status: (typeof rows)[number]["status"]) =>
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)));

    const run = async () => {
      while (!aborted()) {
        // Frame 1: PR opened
        setPhase("open");
        setCmd("");
        setCaret(false);
        setRows([]);
        setDone(null);
        await sleep(2200);
        if (aborted()) return;

        // Frame 2: deploy
        setPhase("deploy");
        await typeCmd(`alchemy deploy --stage ${STAGE}`);
        if (aborted()) return;
        await sleep(220);
        setRows(RESOURCES.map((r) => ({ ...r, status: "ready" })));
        await sleep(260);
        const t0 = Date.now();
        for (const r of RESOURCES) {
          if (aborted()) return;
          updateRow(r.id, "creating");
          await sleep(560);
          if (aborted()) return;
          updateRow(r.id, "created");
          await sleep(120);
        }
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        setDone({ verb: "deployed", secs: elapsed });
        await sleep(900);
        if (aborted()) return;

        // Frame 3: comment posted
        setPhase("comment");
        await sleep(2400);
        if (aborted()) return;

        // Frame 4: observe — same alchemy.run.ts also declares
        // dashboards/alarms; show a live dashboard mock.
        setPhase("observe");
        await sleep(3600);
        if (aborted()) return;

        // Frame 5: merged → destroy
        setPhase("destroy");
        setCmd("");
        setDone(null);
        await sleep(700);
        await typeCmd(`alchemy destroy --stage ${STAGE}`);
        if (aborted()) return;
        await sleep(160);
        const tD = Date.now();
        for (const r of [...RESOURCES].reverse()) {
          if (aborted()) return;
          updateRow(r.id, "deleting");
          await sleep(380);
          if (aborted()) return;
          updateRow(r.id, "deleted");
          await sleep(80);
        }
        const elapsedD = ((Date.now() - tD) / 1000).toFixed(1);
        setDone({ verb: "destroyed", secs: elapsedD });
        await sleep(2400);
      }
    };

    run();
    return () => {
      cancelRef.current = true;
    };
  }, []);

  const anyInFlight = rows.some(
    (r) => r.status === "creating" || r.status === "deleting",
  );
  const spinner = useSpinner(anyInFlight);

  const accent =
    phase === "destroy"
      ? "var(--alc-danger)"
      : phase === "observe"
        ? "var(--alc-success)"
        : "var(--alc-accent-bright)";
  const badge =
    phase === "open"
      ? "PR OPENED"
      : phase === "deploy"
        ? "DEPLOY"
        : phase === "comment"
          ? "PREVIEW LIVE"
          : phase === "observe"
            ? "OBSERVE"
            : "DESTROY";

  return (
    <div className="pr-lc">
      <ol className="pr-lc__timeline" aria-label="PR lifecycle">
        {PHASES.map((p, i) => {
          const activeIdx = PHASES.findIndex((x) => x.id === phase);
          const state =
            i < activeIdx ? "done" : i === activeIdx ? "active" : "todo";
          return (
            <li key={p.id} className={`pr-lc__step pr-lc__step--${state}`}>
              <span className="pr-lc__step-num">{i + 1}</span>
              <span className="pr-lc__step-label">{p.label}</span>
            </li>
          );
        })}
      </ol>

      <div className="pr-lc__stage">
        {/* LEFT: PR card */}
        <div className="pr-lc__pr">
          <div className="pr-lc__pr-head">
            <span
              className={`pr-lc__pr-pill pr-lc__pr-pill--${phase === "destroy" ? "merged" : "open"}`}
            >
              {phase === "destroy" ? (
                <>
                  <span aria-hidden>⬣</span> Merged
                </>
              ) : (
                <>
                  <span aria-hidden>◍</span> Open
                </>
              )}
            </span>
            <span className="pr-lc__pr-num">#{PR_NUMBER}</span>
          </div>
          <div className="pr-lc__pr-title">Add image upload to /photos</div>
          <div className="pr-lc__pr-meta">
            <span className="pr-lc__pr-branch">feature/photo-upload</span>
            <span className="pr-lc__pr-sep">→</span>
            <span className="pr-lc__pr-branch pr-lc__pr-branch--base">
              main
            </span>
          </div>
          <div className="pr-lc__pr-checks">
            <div
              className={`pr-lc__check ${phase === "open" ? "pr-lc__check--running" : "pr-lc__check--done"}`}
            >
              <span className="pr-lc__check-dot" />
              <span>Deploy preview</span>
              {phase === "open" ? (
                <span className="pr-lc__check-status">queued</span>
              ) : (
                <span className="pr-lc__check-status">success</span>
              )}
            </div>
            {(phase === "comment" ||
              phase === "observe" ||
              phase === "destroy") && (
              <div className="pr-lc__check pr-lc__check--done">
                <span className="pr-lc__check-dot" />
                <span>alchemy-bot commented</span>
                <span className="pr-lc__check-status">just now</span>
              </div>
            )}
            {(phase === "observe" || phase === "destroy") && (
              <div className="pr-lc__check pr-lc__check--done">
                <span className="pr-lc__check-dot" />
                <span>Dashboard live</span>
                <span className="pr-lc__check-status">2 widgets · 1 alarm</span>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: terminal, github comment, or dashboard, depending on phase */}
        <div className="pr-lc__panel">
          {phase === "observe" ? (
            <DashboardMock />
          ) : phase === "comment" ? (
            <div className="gh-mock pr-lc__gh">
              <div className="gh-mock__head">
                <div className="gh-mock__avatar">a</div>
                <div className="gh-mock__author">
                  <strong>alchemy-bot</strong>
                  <span className="gh-mock__bot-tag">bot</span>
                  <span className="gh-mock__meta">commented just now</span>
                </div>
              </div>
              <div className="gh-mock__body">
                <h3 className="gh-mock__h3">Preview Deployed</h3>
                <p className="gh-mock__p">
                  <strong>URL:</strong>{" "}
                  <a
                    href="#"
                    className="gh-mock__url"
                    onClick={(e) => e.preventDefault()}
                  >
                    {PREVIEW_URL}
                  </a>
                </p>
                <p className="gh-mock__p">
                  Built from commit{" "}
                  <code className="gh-mock__code">a8f3d21</code>
                </p>
                <hr className="gh-mock__hr" />
                <p className="gh-mock__small">
                  <em>This comment updates automatically with each push.</em>
                </p>
              </div>
            </div>
          ) : (
            <TermChrome
              title={`ci · ${STAGE}`}
              badge={badge}
              badgeColor={accent}
              maxLines={10}
            >
              <Line>
                <span style={{ color: accent }}>$ </span>
                {cmd}
                {caret && (
                  <span style={{ color: "var(--alc-fg-invert)" }}>▍</span>
                )}
              </Line>
              {phase === "open" && (
                <>
                  <Line> </Line>
                  <Line>
                    <span style={{ color: "var(--alc-code-comment)" }}>
                      {`# pull_request opened — STAGE=${STAGE}`}
                    </span>
                  </Line>
                  <Line>
                    <span style={{ color: "var(--alc-code-comment)" }}>
                      # workflow queued…
                    </span>
                  </Line>
                </>
              )}
              {rows.length > 0 && (
                <>
                  <Line> </Line>
                  {rows.map((r) => {
                    const isInFlight =
                      r.status === "creating" || r.status === "deleting";
                    const isDone =
                      r.status === "created" || r.status === "deleted";
                    const icon = isInFlight
                      ? spinner
                      : isDone
                        ? "✓"
                        : phase === "destroy"
                          ? "-"
                          : "+";
                    return (
                      <Line key={r.id}>
                        <span
                          style={{
                            color: accent,
                            width: "1.2em",
                            display: "inline-block",
                          }}
                        >
                          {icon}
                        </span>
                        <span
                          style={{
                            color: "var(--alc-fg-invert)",
                            fontWeight: 600,
                          }}
                        >
                          {r.id}
                        </span>
                        <span style={{ color: "var(--alc-code-comment)" }}>
                          {` (${r.type})`}
                        </span>
                        {isInFlight && (
                          <span style={{ color: accent, marginLeft: 6 }}>
                            {r.status}
                          </span>
                        )}
                      </Line>
                    );
                  })}
                </>
              )}
              {done && (
                <>
                  <Line> </Line>
                  <Line>
                    <span style={{ color: accent }}>✓ </span>
                    <span>{done.verb} in </span>
                    <span
                      style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}
                    >
                      {done.secs}s
                    </span>
                  </Line>
                  {phase === "deploy" && (
                    <Line>
                      <span style={{ color: "var(--alc-code-comment)" }}>
                        {"  → "}
                      </span>
                      <span style={{ color: accent }}>{PREVIEW_URL}</span>
                    </Line>
                  )}
                </>
              )}
            </TermChrome>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Dashboard mock — shown during the `observe` phase.
   Three tiles: p99 latency sparkline (Axiom violet),
   requests/sec sparkline (Datadog purple), 5xx ratio big-number
   (CloudWatch pink). Live-feel via cheap interval ticks.
   ============================================================ */

const SPARK_W = 220;
const SPARK_H = 44;
const SPARK_POINTS = 24;

function useSeries(seed: number, range: [number, number]): number[] {
  const [series, setSeries] = useState<number[]>(() => {
    const arr: number[] = [];
    let v = (range[0] + range[1]) / 2;
    for (let i = 0; i < SPARK_POINTS; i++) {
      v = clamp(
        v + (pseudo(seed + i) - 0.5) * (range[1] - range[0]) * 0.35,
        range[0],
        range[1],
      );
      arr.push(v);
    }
    return arr;
  });
  useEffect(() => {
    let i = SPARK_POINTS;
    const t = setInterval(() => {
      setSeries((prev) => {
        const last = prev[prev.length - 1] ?? (range[0] + range[1]) / 2;
        const next = clamp(
          last + (pseudo(seed + i++) - 0.5) * (range[1] - range[0]) * 0.35,
          range[0],
          range[1],
        );
        return [...prev.slice(1), next];
      });
    }, 600);
    return () => clearInterval(t);
  }, [seed, range[0], range[1]]);
  return series;
}

function pseudo(n: number): number {
  const x = Math.sin(n * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}
function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function Sparkline({
  data,
  color,
  range,
}: {
  data: number[];
  color: string;
  range: [number, number];
}) {
  const [lo, hi] = range;
  const stepX = SPARK_W / (data.length - 1);
  const yFor = (v: number) => SPARK_H - ((v - lo) / (hi - lo)) * SPARK_H;
  const d = data
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"} ${(i * stepX).toFixed(1)} ${yFor(v).toFixed(1)}`,
    )
    .join(" ");
  const fillD = `${d} L ${SPARK_W} ${SPARK_H} L 0 ${SPARK_H} Z`;
  return (
    <svg
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      className="pr-lc__spark"
      preserveAspectRatio="none"
    >
      <path d={fillD} fill={color} fillOpacity={0.12} />
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DashboardMock() {
  const p99 = useSeries(11, [120, 320]);
  const rps = useSeries(29, [180, 540]);
  const errSeries = useSeries(53, [0.0, 0.9]);
  const p99Last = p99[p99.length - 1] ?? 0;
  const rpsLast = rps[rps.length - 1] ?? 0;
  const errLast = errSeries[errSeries.length - 1] ?? 0;
  return (
    <div className="pr-lc__dash">
      <div className="pr-lc__dash-head">
        <span className="pr-lc__dash-title">ApiHealth</span>
        <span className="pr-lc__dash-meta">stage · pr-{147} · live</span>
        <span className="pr-lc__dash-pulse" aria-hidden />
      </div>
      <div className="pr-lc__dash-grid">
        <div className="pr-lc__tile" style={{ ["--c" as never]: "#9F6FFF" }}>
          <div className="pr-lc__tile-label">p99 latency</div>
          <div className="pr-lc__tile-value">
            {Math.round(p99Last)}
            <span className="pr-lc__tile-unit">ms</span>
          </div>
          <Sparkline data={p99} color="#9F6FFF" range={[120, 320]} />
        </div>
        <div className="pr-lc__tile" style={{ ["--c" as never]: "#632CA6" }}>
          <div className="pr-lc__tile-label">requests / sec</div>
          <div className="pr-lc__tile-value">{Math.round(rpsLast)}</div>
          <Sparkline data={rps} color="#632CA6" range={[180, 540]} />
        </div>
        <div className="pr-lc__tile" style={{ ["--c" as never]: "#E7157B" }}>
          <div className="pr-lc__tile-label">5xx ratio</div>
          <div className="pr-lc__tile-value">
            {errLast.toFixed(2)}
            <span className="pr-lc__tile-unit">%</span>
          </div>
          <div className="pr-lc__tile-foot">alarm &gt; 1.00 · ok</div>
        </div>
      </div>
      <div className="pr-lc__dash-foot">
        declared in <code>alchemy.run.ts</code> · exporter: Axiom
      </div>
    </div>
  );
}
