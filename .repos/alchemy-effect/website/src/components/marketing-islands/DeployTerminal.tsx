import { useEffect, useRef, useState } from "react";
import { Line, sleep, TermChrome, useSpinner } from "./_terminal";

const ACTION_ICON: Record<string, string> = {
  create: "+",
  update: "~",
  delete: "-",
  replace: "!",
  noop: "•",
};
const ACTION_COLOR: Record<string, string> = {
  create: "var(--alc-success)",
  update: "var(--alc-warn)",
  delete: "var(--alc-danger)",
  replace: "#c4729a",
};
const MODE_ACCENT: Record<string, string> = {
  idle: "var(--alc-code-comment)",
  plan: "var(--alc-code-type)",
  deploy: "var(--alc-accent-bright)",
  destroy: "var(--alc-danger)",
};
const MODE_LABEL: Record<string, string> = {
  plan: "PLAN",
  deploy: "DEPLOY",
  destroy: "DESTROY",
};

interface Resource {
  id: string;
  type: string;
  bindings: string[];
}
const RESOURCES: Resource[] = [
  { id: "Photos", type: "Cloudflare.R2.Bucket", bindings: [] },
  { id: "Sessions", type: "Cloudflare.KV.Namespace", bindings: [] },
  { id: "Api", type: "Cloudflare.Worker", bindings: ["Photos", "Sessions"] },
];

type RowStatus = "ready" | "creating" | "deleting" | "created" | "deleted";
interface Row extends Resource {
  action: string;
  status: RowStatus;
}

export default function DeployTerminal({
  title = "~/my-app",
  bare,
}: {
  title?: string;
  bare?: boolean;
}) {
  const [mode, setMode] = useState<"idle" | "plan" | "deploy" | "destroy">(
    "idle",
  );
  const [cmd, setCmd] = useState("");
  const [caret, setCaret] = useState(false);
  const [header, setHeader] = useState<{
    verb: string;
    count: number;
    action: string;
  } | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<{
    verb: string;
    secs: string;
    url?: string;
  } | null>(null);
  const [proceed, setProceed] = useState<null | "show" | "confirmed">(null);

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

    const updateRow = (id: string, patch: Partial<Row>) =>
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

    const setAllRowsAction = (action: string, status: RowStatus = "ready") =>
      setRows((rs) => rs.map((r) => ({ ...r, action, status })));

    const revealRows = async (action: string, perRowMs = 130) => {
      setRows([]);
      for (const r of RESOURCES) {
        if (aborted()) return;
        setRows((rs) => [
          ...rs,
          { ...r, action, status: "ready" as RowStatus },
        ]);
        await sleep(perRowMs);
      }
    };

    const startResource = async (id: string, status: RowStatus, ms: number) => {
      if (aborted()) return;
      updateRow(id, { status });
      await sleep(ms);
      if (aborted()) return;
      const done: RowStatus = status === "creating" ? "created" : "deleted";
      updateRow(id, { status: done });
    };

    const run = async () => {
      while (!aborted()) {
        setMode("plan");
        setHeader(null);
        setRows([]);
        setSummary(null);
        setProceed(null);
        await typeCmd("alchemy plan");
        if (aborted()) return;
        await sleep(250);
        setHeader({ verb: "Plan", count: RESOURCES.length, action: "create" });
        await sleep(150);
        await revealRows("create");
        await sleep(2400);

        if (aborted()) return;
        setMode("deploy");
        setSummary(null);
        await typeCmd("alchemy deploy");
        if (aborted()) return;
        setHeader({ verb: "Apply", count: RESOURCES.length, action: "create" });
        await sleep(300);
        setProceed("show");
        await sleep(900);
        if (aborted()) return;
        setProceed("confirmed");
        await sleep(450);
        if (aborted()) return;
        setProceed(null);
        const t0 = Date.now();
        await Promise.all([
          startResource("Photos", "creating", 1000),
          (async () => {
            await sleep(220);
            await startResource("Sessions", "creating", 900);
          })(),
        ]);
        if (aborted()) return;
        await startResource("Api", "creating", 1300);
        if (aborted()) return;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        setSummary({
          verb: "deployed",
          secs: elapsed,
          url: "https://api.my-app.workers.dev",
        });
        await sleep(2600);

        if (aborted()) return;
        setMode("destroy");
        setSummary(null);
        await typeCmd("alchemy destroy");
        if (aborted()) return;
        setHeader({ verb: "Apply", count: RESOURCES.length, action: "delete" });
        setAllRowsAction("delete", "ready");
        await sleep(350);
        setProceed("show");
        await sleep(900);
        setProceed("confirmed");
        await sleep(400);
        setProceed(null);
        const tD = Date.now();
        await startResource("Api", "deleting", 900);
        if (aborted()) return;
        await Promise.all([
          startResource("Photos", "deleting", 700),
          (async () => {
            await sleep(180);
            await startResource("Sessions", "deleting", 650);
          })(),
        ]);
        if (aborted()) return;
        const elapsedD = ((Date.now() - tD) / 1000).toFixed(1);
        setSummary({ verb: "destroyed", secs: elapsedD });
        await sleep(2800);
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
  const accent = MODE_ACCENT[mode]!;

  const renderRow = (r: Row) => {
    const actionColor = ACTION_COLOR[r.action] ?? "var(--alc-code-comment)";
    let icon: string,
      iconColor: string,
      statusWord: string | null = null,
      statusColor = "";
    if (r.status === "ready") {
      icon = ACTION_ICON[r.action] ?? "•";
      iconColor = actionColor;
    } else if (r.status === "creating" || r.status === "deleting") {
      icon = spinner;
      iconColor = actionColor;
      statusWord = r.status;
      statusColor = actionColor;
    } else if (r.status === "created" || r.status === "deleted") {
      icon = "✓";
      iconColor = actionColor;
      statusWord = r.status;
      statusColor = actionColor;
    } else {
      icon = " ";
      iconColor = "transparent";
    }

    const bindingIcon = ACTION_ICON[r.action] ?? "+";
    const bindingCount = r.bindings.length;

    return (
      <div key={r.id}>
        <div
          style={{
            minHeight: "1.55em",
            whiteSpace: "pre",
            transition: "opacity 200ms ease",
          }}
        >
          <span
            style={{
              color: iconColor,
              width: "1.2em",
              display: "inline-block",
              transition: "color 200ms ease",
            }}
          >
            {icon}
          </span>
          <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>
            {r.id}
          </span>
          <span
            style={{ color: "var(--alc-code-comment)" }}
          >{` (${r.type})`}</span>
          {bindingCount > 0 && (
            <span
              style={{ color: "var(--alc-code-type)" }}
            >{` (${bindingCount} bindings)`}</span>
          )}
          {statusWord && (
            <span
              style={{
                color: statusColor,
                marginLeft: 6,
                transition: "color 200ms ease",
              }}
            >
              {statusWord}
            </span>
          )}
        </div>
        {bindingCount > 0 &&
          r.bindings.map((b) => (
            <div
              key={`${r.id}-${b}`}
              style={{ minHeight: "1.55em", whiteSpace: "pre" }}
            >
              <span style={{ width: "1.2em", display: "inline-block" }}> </span>
              <span
                style={{
                  color: actionColor,
                  width: "1.2em",
                  display: "inline-block",
                  transition: "color 200ms ease",
                }}
              >
                {bindingIcon}
              </span>
              <span style={{ color: "var(--alc-code-type)" }}>{b}</span>
            </div>
          ))}
      </div>
    );
  };

  return (
    <TermChrome
      title={title}
      badge={mode !== "idle" ? MODE_LABEL[mode] : undefined}
      badgeColor={accent}
      maxLines={13}
      bare={bare}
    >
      <Line>
        <span style={{ color: accent, transition: "color 280ms ease" }}>
          ${" "}
        </span>
        {cmd}
        {caret && <span style={{ color: "var(--alc-fg-invert)" }}>▍</span>}
      </Line>
      {header && (
        <>
          <Line> </Line>
          <Line>
            <span
              style={{
                textDecoration: "underline",
                color: accent,
                transition: "color 280ms ease",
                fontWeight: 600,
              }}
            >
              {header.verb}
            </span>
            <span>: </span>
            <span style={{ color: ACTION_COLOR[header.action] }}>
              {header.count} to {header.action}
            </span>
          </Line>
        </>
      )}
      {rows.length > 0 && (
        <>
          <Line> </Line>
          {rows.map(renderRow)}
        </>
      )}
      {proceed && (
        <>
          <Line> </Line>
          <Line>Proceed?</Line>
          <Line>
            {proceed === "confirmed" ? (
              <>
                <span style={{ color: accent, transition: "color 200ms ease" }}>
                  {"◉ Yes "}
                </span>
                <span style={{ color: "var(--alc-code-comment)" }}>
                  {"○ No"}
                </span>
              </>
            ) : (
              <>
                <span style={{ color: "var(--alc-fg-invert)" }}>
                  {"◉ Yes "}
                </span>
                <span style={{ color: "var(--alc-code-comment)" }}>
                  {"○ No"}
                </span>
              </>
            )}
          </Line>
        </>
      )}
      {summary && (
        <>
          <Line> </Line>
          <Line>
            <span style={{ color: accent, transition: "color 280ms ease" }}>
              ✓{" "}
            </span>
            <span>{summary.verb} in </span>
            <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>
              {summary.secs}s
            </span>
          </Line>
          {summary.url && (
            <Line>
              <span style={{ color: "var(--alc-code-comment)" }}>{"  → "}</span>
              <span style={{ color: accent, transition: "color 280ms ease" }}>
                {summary.url}
              </span>
            </Line>
          )}
        </>
      )}
    </TermChrome>
  );
}
