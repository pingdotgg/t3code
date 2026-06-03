import { useEffect, useRef, useState } from "react";
import { Line, sleep, TermChrome, useSpinner } from "./_terminal";

interface BootstrapResource {
  id: string;
  type: string;
  /** Optional sub-line shown beneath the resource while creating, e.g. progress notes. */
  note?: string;
}

const RESOURCES: BootstrapResource[] = [
  {
    id: "AlchemyStateStoreToken",
    type: "Cloudflare.SecretsStore.Secret",
  },
  {
    id: "Api",
    type: "Cloudflare.Worker",
    note: "Enabling workers.dev subdomain...",
  },
  { id: "StateStoreAuthTokenValue", type: "Alchemy.Random" },
  {
    id: "StateStoreEncryptionKey",
    type: "Cloudflare.SecretsStore.Secret",
  },
  { id: "StateStoreEncryptionKeyValue", type: "Alchemy.Random" },
  { id: "StateStoreSecrets", type: "Cloudflare.SecretsStore" },
];

type RowStatus = "pending" | "creating" | "created";
interface Row extends BootstrapResource {
  status: RowStatus;
}

type PromptState = "hidden" | "asking" | "confirmed";

const ACCENT = "var(--alc-accent-bright)";

export default function StateStoreBootstrap({
  title = "~/my-app",
  bare,
  maxLines = 12,
}: {
  title?: string;
  bare?: boolean;
  maxLines?: number;
}) {
  const [cmd, setCmd] = useState("");
  const [caret, setCaret] = useState(false);
  const [prompt, setPrompt] = useState<PromptState>("hidden");
  const [rows, setRows] = useState<Row[]>([]);

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
      await sleep(220);
      setCaret(false);
    };

    const updateRow = (id: string, patch: Partial<Row>) =>
      setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

    const reset = () => {
      setCmd("");
      setCaret(false);
      setPrompt("hidden");
      setRows([]);
    };

    const run = async () => {
      while (!aborted()) {
        reset();
        await sleep(400);
        await typeCmd("bun alchemy deploy");
        if (aborted()) return;
        await sleep(450);

        setPrompt("asking");
        await sleep(1100);
        if (aborted()) return;
        setPrompt("confirmed");
        await sleep(550);
        if (aborted()) return;

        // Seed all rows as pending so the layout doesn't jump.
        setRows(RESOURCES.map((r) => ({ ...r, status: "pending" })));
        await sleep(280);

        for (const r of RESOURCES) {
          if (aborted()) return;
          updateRow(r.id, { status: "creating" });
          await sleep(r.note ? 1100 : 700);
          if (aborted()) return;
          updateRow(r.id, { status: "created" });
          await sleep(180);
        }

        await sleep(3200);
      }
    };

    run();
    return () => {
      cancelRef.current = true;
    };
  }, []);

  const anyInFlight = rows.some((r) => r.status === "creating");
  const spinner = useSpinner(anyInFlight);

  const renderRow = (r: Row) => {
    let icon: string;
    let iconColor: string;

    if (r.status === "pending") {
      icon = "·";
      iconColor = "var(--alc-code-comment)";
    } else if (r.status === "creating") {
      icon = spinner;
      iconColor = ACCENT;
    } else {
      icon = "✓";
      iconColor = ACCENT;
    }

    const labelColor =
      r.status === "pending"
        ? "var(--alc-code-comment)"
        : "var(--alc-fg-invert)";
    const labelWeight = r.status === "pending" ? 400 : 600;

    return (
      <div key={r.id}>
        <div style={{ minHeight: "1.55em", whiteSpace: "pre" }}>
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
          <span
            style={{
              color: labelColor,
              fontWeight: labelWeight,
              transition: "color 200ms ease",
            }}
          >
            {r.id}
          </span>
          <span
            style={{ color: "var(--alc-code-comment)" }}
          >{` (${r.type})`}</span>
          {r.status === "created" && (
            <span style={{ color: ACCENT, marginLeft: 6 }}>created</span>
          )}
        </div>
        {r.note && (r.status === "creating" || r.status === "created") && (
          <div
            style={{
              minHeight: "1.55em",
              whiteSpace: "pre",
              color: "var(--alc-code-comment)",
            }}
          >
            <span style={{ width: "1.2em", display: "inline-block" }}> </span>
            <span>• {r.note}</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <TermChrome
      title={title}
      badge="DEPLOY"
      badgeColor={ACCENT}
      maxLines={maxLines}
      bare={bare}
    >
      <Line>
        <span style={{ color: ACCENT }}>$ </span>
        {cmd}
        {caret && <span style={{ color: "var(--alc-fg-invert)" }}>▍</span>}
      </Line>
      {prompt !== "hidden" && (
        <>
          <Line>
            <span style={{ color: "var(--alc-code-comment)" }}>│</span>
          </Line>
          <Line>
            <span style={{ color: ACCENT, marginRight: 4 }}>◇</span>
            <span style={{ color: "var(--alc-fg-invert)" }}>
              {"  Cloudflare State Store not found. Do you want to deploy it?"}
            </span>
          </Line>
          <Line>
            <span style={{ color: "var(--alc-code-comment)" }}>│</span>
            <span
              style={{
                marginLeft: 4,
                color: prompt === "confirmed" ? ACCENT : "var(--alc-fg-invert)",
                transition: "color 200ms ease",
              }}
            >
              {"  Yes"}
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
    </TermChrome>
  );
}
