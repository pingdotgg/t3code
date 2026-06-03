import { useEffect, useRef, useState } from "react";
import { Line, sleep, TermChrome, useSpinner } from "./_terminal";

const RESOURCES = [
  { id: "Bucket", type: "Cloudflare.R2Bucket" },
  { id: "Worker", type: "Cloudflare.Worker" },
];

const OUTPUTS: { key: string; value: string }[] = [
  { key: "bucketName", value: '"myapp-dev_sam-bucket-a3f1"' },
  {
    key: "url",
    value: '"https://myapp-worker-dev_sam-abc123.workers.dev"',
  },
];

const STAGE = "dev_sam";
const COMMAND = `alchemy deploy --stage ${STAGE}`;

type RowStatus = "pending" | "creating" | "created";

export default function StackOutputsTerminal({
  maxLines = 12,
}: {
  maxLines?: number;
}) {
  const [cmd, setCmd] = useState("");
  const [caret, setCaret] = useState(false);
  const [rows, setRows] = useState<
    { id: string; type: string; status: RowStatus }[]
  >([]);
  const [showOutputs, setShowOutputs] = useState(false);
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
      await sleep(160);
      setCaret(false);
    };

    const update = (id: string, status: RowStatus) =>
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, status } : r)));

    const run = async () => {
      while (!aborted()) {
        setCmd("");
        setCaret(false);
        setRows([]);
        setShowOutputs(false);
        await sleep(900);
        if (aborted()) return;

        await typeCmd(COMMAND);
        if (aborted()) return;

        await sleep(220);
        setRows(
          RESOURCES.map((r) => ({ ...r, status: "pending" as RowStatus })),
        );
        await sleep(260);

        for (const r of RESOURCES) {
          if (aborted()) return;
          update(r.id, "creating");
          await sleep(620);
          if (aborted()) return;
          update(r.id, "created");
          await sleep(140);
        }

        await sleep(260);
        setShowOutputs(true);
        await sleep(4200);
      }
    };

    run();
    return () => {
      cancelRef.current = true;
    };
  }, []);

  const anyInFlight = rows.some((r) => r.status === "creating");
  const spinner = useSpinner(anyInFlight);
  const accent = "var(--alc-accent-bright)";

  return (
    <TermChrome
      title={`alchemy · ${STAGE}`}
      badge="DEPLOY"
      badgeColor={accent}
      maxLines={maxLines}
    >
      <Line>
        <span style={{ color: accent }}>$ </span>
        {cmd}
        {caret && <span style={{ color: "var(--alc-fg-invert)" }}>▍</span>}
      </Line>
      {rows.length > 0 && (
        <>
          <Line> </Line>
          {rows.map((r) => {
            const inFlight = r.status === "creating";
            const done = r.status === "created";
            const icon = inFlight ? spinner : done ? "✓" : "+";
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
                  style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}
                >
                  {r.id}
                </span>
                <span style={{ color: "var(--alc-code-comment)" }}>
                  {` (${r.type})`}
                </span>
                {inFlight && (
                  <span style={{ color: accent, marginLeft: 6 }}>
                    {r.status}
                  </span>
                )}
              </Line>
            );
          })}
        </>
      )}
      {showOutputs && (
        <>
          <Line> </Line>
          <Line>
            <span style={{ color: accent }}>✓ </span>
            <span>deployed in </span>
            <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>
              3.4s
            </span>
          </Line>
          <Line> </Line>
          <Line>
            <span style={{ color: "var(--alc-code-comment)" }}>outputs:</span>
          </Line>
          <Line>
            <span style={{ color: "var(--alc-fg-invert)" }}>{"{"}</span>
          </Line>
          {OUTPUTS.map((o) => (
            <Line key={o.key}>
              <span style={{ color: "var(--alc-fg-invert)" }}>{"  "}</span>
              <span style={{ color: "var(--alc-fg-invert)" }}>{o.key}</span>
              <span style={{ color: "var(--alc-code-comment)" }}>: </span>
              <span style={{ color: accent }}>{o.value}</span>
              <span style={{ color: "var(--alc-fg-invert)" }}>,</span>
            </Line>
          ))}
          <Line>
            <span style={{ color: "var(--alc-fg-invert)" }}>{"}"}</span>
          </Line>
        </>
      )}
    </TermChrome>
  );
}
