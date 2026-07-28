import { useEffect, useRef, useState } from "react";
import { Line, sleep, TermChrome, useSpinner } from "./_terminal";

interface Step {
  kind: "boot" | "ready" | "edit" | "reload" | "diff" | "wire" | "request";
  label?: string;
  detail?: string;
  ms: number;
}

const STEPS: Step[] = [
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
  { kind: "edit", label: "alchemy.run.ts", ms: 1000 },
  { kind: "diff", label: "Queue", detail: "Cloudflare.Queues.Queue", ms: 700 },
  { kind: "wire", label: "Api → Queue.bind", ms: 700 },
  { kind: "ready", ms: 1100 },
];

interface LogLine {
  text: React.ReactNode;
  key: string;
}

let _id = 0;

export default function DevTerminal({
  title = "~/my-app",
}: {
  title?: string;
}) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    cancelRef.current = false;
    const aborted = () => cancelRef.current;

    const push = (text: React.ReactNode) =>
      setLines((ls) => [...ls, { text, key: `${++_id}` }].slice(-14));

    const reset = () => setLines([]);

    const run = async () => {
      while (!aborted()) {
        reset();
        push(
          <>
            <span style={{ color: "var(--alc-code-comment)" }}>$ </span>
            <span>alchemy dev</span>
          </>,
        );
        await sleep(300);
        if (aborted()) return;

        for (const step of STEPS) {
          if (aborted()) return;
          if (step.kind === "boot") {
            setBusy(true);
            await sleep(step.ms);
            setBusy(false);
            push(
              <>
                <span style={{ color: "var(--alc-success)" }}>✓ </span>
                <span
                  style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}
                >
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
            push(
              <>
                <span style={{ color: "var(--alc-code-comment)" }}> → </span>
                <span style={{ color: "var(--alc-accent-bright)" }}>
                  http://localhost:1337
                </span>
              </>,
            );
            push(
              <>
                <span style={{ color: "var(--alc-code-comment)" }}>
                  Watching for changes…
                </span>
              </>,
            );
          } else if (step.kind === "edit") {
            await sleep(step.ms);
            push(
              <>
                <span style={{ color: "var(--alc-warn)" }}>↻ </span>
                <span style={{ color: "var(--alc-code-comment)" }}>
                  {step.label} changed
                </span>
              </>,
            );
          } else if (step.kind === "reload") {
            setBusy(true);
            await sleep(step.ms);
            setBusy(false);
            push(
              <>
                <span style={{ color: "var(--alc-success)" }}>✓ </span>
                <span
                  style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}
                >
                  Api
                </span>
                <span
                  style={{ color: "var(--alc-code-comment)" }}
                >{` reloaded in `}</span>
                <span
                  style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}
                >
                  {step.detail}
                </span>
              </>,
            );
          } else if (step.kind === "diff") {
            await sleep(step.ms);
            push(
              <>
                <span style={{ color: "var(--alc-success)" }}>+ </span>
                <span
                  style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}
                >
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
            push(
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
            push(
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
        await sleep(2400);
      }
    };

    run();
    return () => {
      cancelRef.current = true;
    };
  }, []);

  const spinner = useSpinner(busy);

  return (
    <TermChrome
      title={title}
      badge="DEV"
      badgeColor="var(--alc-accent-bright)"
      maxLines={15}
    >
      {lines.map((l) => (
        <Line key={l.key}>{l.text}</Line>
      ))}
      {busy && (
        <Line>
          <span style={{ color: "var(--alc-code-comment)" }}>{spinner} </span>
        </Line>
      )}
    </TermChrome>
  );
}
