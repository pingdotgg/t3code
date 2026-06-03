import { Fragment, useEffect, useRef, useState } from "react";
import { Line, sleep, TermChrome, useSpinner } from "./_terminal";

const TEST_STAGE = "pr-1729";

interface BaseStep {
  id: string;
  label: string;
  runMs: number;
}
interface PhaseStep extends BaseStep {
  kind: "phase";
  detail: string;
  durSec: string;
  url?: string;
}
interface TestStep extends BaseStep {
  kind: "test";
  durMs: string;
}
type Step = PhaseStep | TestStep;
type RunningStep = Step & { status: "running" | "done" };

const TEST_STEPS: Step[] = [
  {
    id: "deploy",
    kind: "phase",
    label: "deploy",
    detail: "3 resources",
    runMs: 1100,
    durSec: "4.2",
    url: `https://api.${TEST_STAGE}.workers.dev`,
  },
  {
    id: "t1",
    kind: "test",
    label: "PUT + GET round-trips through R2",
    runMs: 850,
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
    runMs: 900,
    durSec: "1.8",
  },
];

export default function TestTerminal({
  title = `CI · ${TEST_STAGE}`,
}: {
  title?: string;
}) {
  const [cmd, setCmd] = useState("");
  const [caret, setCaret] = useState(false);
  const [steps, setSteps] = useState<RunningStep[]>([]);
  const [summary, setSummary] = useState<{
    tests: number;
    secs: string;
  } | null>(null);

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
        await sleep(36 + Math.random() * 24);
      }
      await sleep(180);
      setCaret(false);
    };

    const run = async () => {
      while (!aborted()) {
        setSteps([]);
        setSummary(null);
        await typeCmd("bun test");
        if (aborted()) return;
        await sleep(280);

        const t0 = Date.now();
        for (const s of TEST_STEPS) {
          if (aborted()) return;
          setSteps((arr) => [...arr, { ...s, status: "running" }]);
          await sleep(s.runMs);
          if (aborted()) return;
          setSteps((arr) =>
            arr.map((r) => (r.id === s.id ? { ...r, status: "done" } : r)),
          );
          await sleep(160);
        }
        if (aborted()) return;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        setSummary({ tests: 2, secs: elapsed });
        await sleep(2800);
      }
    };

    run();
    return () => {
      cancelRef.current = true;
    };
  }, []);

  const anyRunning = steps.some((s) => s.status === "running");
  const spinner = useSpinner(anyRunning);
  const accent = "var(--alc-accent-bright)";

  const renderStep = (s: RunningStep, idx: number, arr: RunningStep[]) => {
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
  };

  return (
    <TermChrome title={title} badge="TEST" badgeColor={accent} maxLines={10}>
      <Line>
        <span style={{ color: accent }}>$ </span>
        {cmd}
        {caret && <span style={{ color: "var(--alc-fg-invert)" }}>▍</span>}
      </Line>
      {steps.length > 0 && (
        <>
          <Line> </Line>
          {steps.map((s, i, arr) => renderStep(s, i, arr))}
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
            <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>
              {summary.secs}s
            </span>
          </Line>
        </>
      )}
    </TermChrome>
  );
}
