import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Line, sleep, TermChrome, useSpinner } from "./_terminal";

/* ============================================================
   Combined Dev + Test terminal. One TermChrome, two narratives.
   Loops:
     DEV   — alchemy dev (boot → ready → edit → reload → request)
     TEST  — bun test    (deploy → tests → destroy)
   The badge + title swap when the mode flips, reinforcing
   "same primitive, two modes" without doubling vertical space.
   ============================================================ */

type Mode = "dev" | "test";

interface DevStep {
  kind: "boot" | "ready" | "edit" | "reload" | "diff" | "wire" | "request";
  label?: string;
  detail?: string;
  ms: number;
}

const DEV_STEPS: DevStep[] = [
  { kind: "boot", label: "Photos", detail: "Cloudflare.R2.Bucket", ms: 600 },
  {
    kind: "boot",
    label: "Sessions",
    detail: "Cloudflare.KV.Namespace",
    ms: 500,
  },
  {
    kind: "boot",
    label: "Api",
    detail: "Cloudflare.Worker · local → workerd",
    ms: 700,
  },
  { kind: "ready", ms: 700 },
  { kind: "edit", label: "src/Api.ts", ms: 900 },
  { kind: "reload", detail: "38ms", ms: 600 },
  { kind: "request", label: "GET /object/hello.txt", detail: "200", ms: 900 },
  { kind: "edit", label: "alchemy.run.ts", ms: 900 },
  { kind: "diff", label: "Queue", detail: "Cloudflare.Queues.Queue", ms: 700 },
  { kind: "wire", label: "Api → Queue.bind", ms: 700 },
  { kind: "ready", ms: 1000 },
];

const TEST_STAGE = "pr-1729";

interface BaseTestStep {
  id: string;
  label: string;
  runMs: number;
}
interface PhaseTestStep extends BaseTestStep {
  kind: "phase";
  detail: string;
  durSec: string;
  url?: string;
}
interface UnitTestStep extends BaseTestStep {
  kind: "test";
  durMs: string;
}
type TestStep = PhaseTestStep | UnitTestStep;
type RunningTest = TestStep & { status: "running" | "done" };

const TEST_STEPS: TestStep[] = [
  {
    id: "deploy",
    kind: "phase",
    label: "deploy",
    detail: "3 resources",
    runMs: 1000,
    durSec: "4.2",
    url: `https://api.${TEST_STAGE}.workers.dev`,
  },
  {
    id: "t1",
    kind: "test",
    label: "PUT + GET round-trips through R2",
    runMs: 800,
    durMs: "312",
  },
  {
    id: "t2",
    kind: "test",
    label: "Room DO preserves state across requests",
    runMs: 700,
    durMs: "184",
  },
  {
    id: "destroy",
    kind: "phase",
    label: "destroy",
    detail: "3 resources",
    runMs: 800,
    durSec: "1.8",
  },
];

interface LogLine {
  text: ReactNode;
  key: string;
}

let _id = 0;

const DEV_ACCENT = "var(--alc-accent-bright)";
const TEST_ACCENT = "var(--alc-success)";

export default function DevTestTerminal() {
  const [mode, setMode] = useState<Mode>("dev");

  // Dev state
  const [devLines, setDevLines] = useState<LogLine[]>([]);
  const [devBusy, setDevBusy] = useState(false);

  // Test state
  const [cmd, setCmd] = useState("");
  const [caret, setCaret] = useState(false);
  const [testSteps, setTestSteps] = useState<RunningTest[]>([]);
  const [summary, setSummary] = useState<{
    tests: number;
    secs: string;
  } | null>(null);

  const cancelRef = useRef(false);

  useEffect(() => {
    cancelRef.current = false;
    const aborted = () => cancelRef.current;

    const pushDev = (text: ReactNode) =>
      setDevLines((ls) => [...ls, { text, key: `${++_id}` }].slice(-13));
    const resetDev = () => setDevLines([]);

    const typeCmd = async (text: string) => {
      setCmd("");
      setCaret(true);
      for (let i = 1; i <= text.length; i++) {
        if (aborted()) return;
        setCmd(text.slice(0, i));
        await sleep(34 + Math.random() * 22);
      }
      await sleep(160);
      setCaret(false);
    };

    const runDev = async () => {
      resetDev();
      pushDev(
        <>
          <span style={{ color: "var(--alc-code-comment)" }}>$ </span>
          <span>alchemy dev</span>
        </>,
      );
      await sleep(280);
      for (const step of DEV_STEPS) {
        if (aborted()) return;
        if (step.kind === "boot") {
          setDevBusy(true);
          await sleep(step.ms);
          setDevBusy(false);
          pushDev(
            <>
              <span style={{ color: "var(--alc-success)" }}>✓ </span>
              <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>
                {step.label}
              </span>
              <span
                style={{ color: "var(--alc-code-comment)" }}
              >{` (${step.detail})`}</span>
              <span style={{ color: "var(--alc-success)" }}> created</span>
            </>,
          );
        } else if (step.kind === "ready") {
          await sleep(step.ms);
          pushDev(
            <>
              <span style={{ color: "var(--alc-code-comment)" }}> → </span>
              <span style={{ color: "var(--alc-accent-bright)" }}>
                http://localhost:1337
              </span>
            </>,
          );
          pushDev(
            <span style={{ color: "var(--alc-code-comment)" }}>
              Watching for changes…
            </span>,
          );
        } else if (step.kind === "edit") {
          await sleep(step.ms);
          pushDev(
            <>
              <span style={{ color: "var(--alc-warn)" }}>↻ </span>
              <span style={{ color: "var(--alc-code-comment)" }}>
                {step.label} changed
              </span>
            </>,
          );
        } else if (step.kind === "reload") {
          setDevBusy(true);
          await sleep(step.ms);
          setDevBusy(false);
          pushDev(
            <>
              <span style={{ color: "var(--alc-success)" }}>✓ </span>
              <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>
                Api
              </span>
              <span
                style={{ color: "var(--alc-code-comment)" }}
              >{` reloaded in `}</span>
              <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>
                {step.detail}
              </span>
            </>,
          );
        } else if (step.kind === "diff") {
          await sleep(step.ms);
          pushDev(
            <>
              <span style={{ color: "var(--alc-success)" }}>+ </span>
              <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>
                {step.label}
              </span>
              <span
                style={{ color: "var(--alc-code-comment)" }}
              >{` (${step.detail})`}</span>
              <span style={{ color: "var(--alc-success)" }}> created</span>
            </>,
          );
        } else if (step.kind === "wire") {
          await sleep(step.ms);
          pushDev(
            <>
              <span style={{ color: "var(--alc-warn)" }}>~ </span>
              <span style={{ color: "var(--alc-code-comment)" }}>wired </span>
              <span style={{ color: "var(--alc-code-type)" }}>
                {step.label}
              </span>
            </>,
          );
        } else if (step.kind === "request") {
          await sleep(step.ms);
          pushDev(
            <>
              <span
                style={{ color: "var(--alc-code-comment)" }}
              >{`[${new Date().toLocaleTimeString().slice(0, 8)}] `}</span>
              <span style={{ color: "var(--alc-fg-invert)" }}>
                {step.label}
              </span>
              <span
                style={{ color: "var(--alc-success)" }}
              >{`  ${step.detail}`}</span>
            </>,
          );
        }
      }
    };

    const runTest = async () => {
      setTestSteps([]);
      setSummary(null);
      setCmd("");
      await sleep(200);
      await typeCmd("bun test");
      if (aborted()) return;
      await sleep(260);

      const t0 = Date.now();
      for (const s of TEST_STEPS) {
        if (aborted()) return;
        setTestSteps((arr) => [...arr, { ...s, status: "running" }]);
        await sleep(s.runMs);
        if (aborted()) return;
        setTestSteps((arr) =>
          arr.map((r) => (r.id === s.id ? { ...r, status: "done" } : r)),
        );
        await sleep(140);
      }
      if (aborted()) return;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      setSummary({ tests: 2, secs: elapsed });
    };

    const loop = async () => {
      while (!aborted()) {
        setMode("dev");
        await runDev();
        if (aborted()) return;
        await sleep(1600);

        setMode("test");
        await runTest();
        if (aborted()) return;
        await sleep(2400);
      }
    };

    loop();
    return () => {
      cancelRef.current = true;
    };
  }, []);

  const devSpinner = useSpinner(devBusy);
  const anyTestRunning = testSteps.some((s) => s.status === "running");
  const testSpinner = useSpinner(anyTestRunning);

  const accent = mode === "dev" ? DEV_ACCENT : TEST_ACCENT;
  const title = mode === "dev" ? "~/my-app" : `ci · ${TEST_STAGE}`;
  const badge = mode === "dev" ? "DEV" : "TEST";

  return (
    <TermChrome title={title} badge={badge} badgeColor={accent} maxLines={13}>
      {mode === "dev" ? (
        <>
          {devLines.map((l) => (
            <Line key={l.key}>{l.text}</Line>
          ))}
          {devBusy && (
            <Line>
              <span style={{ color: "var(--alc-code-comment)" }}>
                {devSpinner}{" "}
              </span>
            </Line>
          )}
        </>
      ) : (
        <>
          <Line>
            <span style={{ color: accent }}>$ </span>
            {cmd}
            {caret && <span style={{ color: "var(--alc-fg-invert)" }}>▍</span>}
          </Line>
          {testSteps.length > 0 && (
            <>
              <Line> </Line>
              {testSteps.map((s, i, arr) =>
                renderTestStep(s, i, arr, accent, testSpinner),
              )}
            </>
          )}
          {summary && (
            <>
              <Line> </Line>
              <Line>
                <span
                  style={{
                    background: accent,
                    color: "var(--alc-bg-code)",
                    fontWeight: 700,
                    padding: "0 8px",
                    marginRight: 8,
                  }}
                >
                  {" PASS "}
                </span>
                <span>{summary.tests} tests · </span>
                <span
                  style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}
                >
                  {summary.secs}s
                </span>
              </Line>
            </>
          )}
        </>
      )}
    </TermChrome>
  );
}

function renderTestStep(
  s: RunningTest,
  idx: number,
  arr: RunningTest[],
  accent: string,
  spinner: string,
) {
  const isRunning = s.status === "running";
  const icon = isRunning ? spinner : "✓";
  const iconColor = isRunning ? "var(--alc-code-type)" : accent;

  if (s.kind === "phase") {
    return (
      <Fragment key={s.id}>
        <Line>
          <span
            style={{
              color: iconColor,
              width: "1.2em",
              display: "inline-block",
            }}
          >
            {icon}
          </span>
          <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>
            {s.label}
          </span>
          {!isRunning ? (
            <span style={{ color: "var(--alc-code-comment)" }}>
              {` (${s.detail} · ${s.durSec}s)`}
            </span>
          ) : (
            <span
              style={{ color: "var(--alc-code-comment)" }}
            >{` (${s.detail})`}</span>
          )}
        </Line>
        {s.url && !isRunning && (
          <Line>
            <span style={{ color: "var(--alc-code-comment)" }}>{"  → "}</span>
            <span style={{ color: "var(--alc-code-comment)" }}>{s.url}</span>
          </Line>
        )}
        {!isRunning && idx < arr.length - 1 && <Line> </Line>}
      </Fragment>
    );
  }
  return (
    <Line key={s.id}>
      <span
        style={{ color: iconColor, width: "1.2em", display: "inline-block" }}
      >
        {icon}
      </span>
      <span style={{ color: "var(--alc-fg-invert)" }}>{s.label}</span>
      {!isRunning && (
        <span
          style={{ color: "var(--alc-code-comment)" }}
        >{` (${s.durMs}ms)`}</span>
      )}
    </Line>
  );
}
