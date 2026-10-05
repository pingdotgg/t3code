import { useRef, useState, type ReactNode } from "react";
import {
  Line,
  sleep,
  TermChrome,
  useInViewLoop,
  useSpinner,
} from "./_terminal";

/**
 * Faithful emulation of the real `alchemy dev` TUI
 * (packages/alchemy/src/Cli/components/view/SigilCli.tsx + PlanView.tsx):
 *
 * - static scrollback on top (`$ alchemy dev`, Vite HMR and Worker reloads)
 * - the live plan widget below: a `Plan · <counts>` summary rule, TaskRows
 *   with braille spinners, per-status colors/glyphs from Util/Theme.ts, and
 *   the KeyBar footer (`Starting dev stack (n/m) │ p hide widget • Ctrl+C exit`)
 * - on success in dev mode the widget flips to the `Output` view
 *   (`{ url: '…' }` via node inspect), exactly like `startApplySession`
 *   does when the stack output is ready.
 */

// Palette lifted verbatim from packages/alchemy/src/Util/Theme.ts — the
// terminal body is always dark, so the raw hex values are correct here.
const C = {
  brand: "#e28a5b",
  success: "#9acb69",
  warning: "#efb85a",
  info: "#b6c77a",
  muted: "#8f887c",
  accentBright: "#c5df8c",
  emphasis: "#f5f0e6",
};

type Status =
  | "pending"
  | "creating"
  | "created"
  | "updating"
  | "updated"
  | "no change";

interface RowState {
  id: string;
  type: string;
  status: Status;
  elapsed?: string;
}

const statusColor = (s: Status): string =>
  s === "creating" || s === "created"
    ? C.success
    : s === "updating" || s === "updated"
      ? C.warning
      : C.muted;

const inProgress = (s: Status) => s === "creating" || s === "updating";

interface TuiState {
  logs: ReactNode[];
  rows: RowState[];
  view: "plan" | "output";
  label: string; // "Starting dev stack" | "Dev stack ready"
  busy: boolean;
  widget: boolean;
}

const BOOT: TuiState = {
  logs: [],
  rows: [],
  view: "plan",
  label: "Starting dev stack",
  busy: true,
  widget: false,
};

let _key = 0;

export default function DevTuiTerminal({
  title = "~/my-app",
}: {
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TuiState>(BOOT);
  const spinner = useSpinner(true);

  useInViewLoop(ref, async (signal) => {
    const set = (patch: Partial<TuiState>) =>
      setState((s) => ({ ...s, ...patch }));
    const log = (node: ReactNode) =>
      setState((s) => ({
        ...s,
        logs: [...s.logs, <span key={`l${++_key}`}>{node}</span>].slice(-4),
      }));
    const row = (id: string, patch: Partial<RowState>) =>
      setState((s) => ({
        ...s,
        rows: s.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      }));

    while (!signal.aborted) {
      // ── boot: one command starts the Worker and the Vite app ────────
      setState({ ...BOOT, logs: [] });
      log(
        <>
          <span style={{ color: C.muted }}>$ </span>
          <span style={{ color: C.emphasis }}>alchemy dev</span>
        </>,
      );
      await sleep(500);
      if (signal.aborted) return;
      set({
        widget: true,
        rows: [
          { id: "Api", type: "Cloudflare.Worker", status: "creating" },
          { id: "Web", type: "Cloudflare.Website.Vite", status: "creating" },
        ],
      });
      await sleep(900);
      if (signal.aborted) return;
      row("Api", { status: "created", elapsed: "0.6s" });
      await sleep(700);
      if (signal.aborted) return;
      row("Web", { status: "created", elapsed: "1.3s" });
      await sleep(500);
      if (signal.aborted) return;
      set({ view: "output", label: "Dev stack ready", busy: false });
      await sleep(2200);
      if (signal.aborted) return;

      // ── edit the frontend: Vite HMR ─────────────────────────────────
      log(
        <>
          <span style={{ color: C.muted }}>[web] </span>
          <span style={{ color: C.info }}>hmr update </span>
          <span style={{ color: C.emphasis }}>/src/App.tsx</span>
          <span style={{ color: C.muted }}> (96ms)</span>
        </>,
      );
      await sleep(1800);
      if (signal.aborted) return;

      // ── edit the backend: the Worker reloads in place ───────────────
      log(
        <>
          <span style={{ color: C.muted }}>[api] </span>
          <span style={{ color: C.info }}>reloaded </span>
          <span style={{ color: C.emphasis }}>src/api.ts</span>
          <span style={{ color: C.muted }}> (41ms)</span>
        </>,
      );
      await sleep(1800);
      if (signal.aborted) return;

      // ── edit alchemy.run.ts: a new bucket, bound to the Worker ──────
      log(
        <>
          <span style={{ color: C.warning }}>↻ </span>
          <span style={{ color: C.muted }}>
            alchemy.run.ts changed — reloading stack
          </span>
        </>,
      );
      await sleep(600);
      if (signal.aborted) return;
      set({
        view: "plan",
        label: "Starting dev stack",
        busy: true,
        rows: [
          { id: "Uploads", type: "Cloudflare.R2.Bucket", status: "creating" },
          { id: "Api", type: "Cloudflare.Worker", status: "pending" },
          { id: "Web", type: "Cloudflare.Website.Vite", status: "no change" },
        ],
      });
      await sleep(900);
      if (signal.aborted) return;
      row("Uploads", { status: "created", elapsed: "0.3s" });
      row("Api", { status: "updating" });
      await sleep(800);
      if (signal.aborted) return;
      row("Api", { status: "updated", elapsed: "0.4s" });
      await sleep(500);
      if (signal.aborted) return;
      set({ view: "output", label: "Dev stack ready", busy: false });
      await sleep(3500);
    }
  });

  const done = state.rows.filter((r) => !inProgress(r.status)).length;
  const summaryCounts = summarize(state.rows);

  return (
    <div ref={ref}>
      <TermChrome
        title={title}
        badge="DEV"
        badgeColor="var(--alc-accent-bright)"
        maxLines={12}
      >
        {state.logs.map((l, i) => (
          <Line key={i}>{l}</Line>
        ))}
        {state.widget && (
          <>
            {/* summary rule — PlanView renders `Plan · counts` (or `Output`) */}
            <Rule>
              {state.view === "output" ? (
                <b style={{ color: C.brand }}>Output</b>
              ) : (
                <>
                  <b style={{ color: C.brand }}>Plan</b>
                  <span style={{ color: C.muted }}> · </span>
                  {summaryCounts.map((part, i) => (
                    <span key={part.label}>
                      {i > 0 && <span style={{ color: C.muted }}> · </span>}
                      <span style={{ color: part.color }}>{part.label}</span>
                    </span>
                  ))}
                </>
              )}
            </Rule>
            {state.view === "output" ? (
              <>
                <Line>
                  <span style={{ color: C.muted }}>{"{"}</span>
                </Line>
                <Line>
                  <span style={{ color: C.muted }}>{"  "}web: </span>
                  <span style={{ color: C.accentBright }}>
                    'http://localhost:5173'
                  </span>
                  <span style={{ color: C.muted }}>,</span>
                </Line>
                <Line>
                  <span style={{ color: C.muted }}>{"  "}api: </span>
                  <span style={{ color: C.accentBright }}>
                    'http://localhost:1337'
                  </span>
                </Line>
                <Line>
                  <span style={{ color: C.muted }}>{"}"}</span>
                </Line>
              </>
            ) : (
              state.rows.map((r) => (
                <Line key={r.id}>
                  <span style={{ color: statusColor(r.status) }}>
                    {inProgress(r.status)
                      ? spinner
                      : r.status === "pending"
                        ? "·"
                        : "✓"}
                  </span>{" "}
                  <b style={{ color: C.emphasis }}>{r.id}</b>
                  <span style={{ color: C.muted }}> ({r.type}) </span>
                  <span style={{ color: statusColor(r.status) }}>
                    {r.status}
                  </span>
                  {r.elapsed && (
                    <span style={{ color: C.muted }}> ({r.elapsed})</span>
                  )}
                </Line>
              ))
            )}
            {/* keybar footer — spinner + label (+ progress) │ keys */}
            <Rule>
              {state.busy && <span style={{ color: C.brand }}>{spinner} </span>}
              <b style={{ color: C.brand }}>{state.label}</b>
              {state.busy && state.rows.length > 0 && (
                <span style={{ color: C.muted }}>
                  {" "}
                  ({done}/{state.rows.length})
                </span>
              )}
              <span style={{ color: C.muted }}> │ </span>
              <Key k="p" label="hide widget" />
              <span style={{ color: C.muted }}> • </span>
              <Key k="Ctrl+C" label="exit" />
            </Rule>
          </>
        )}
      </TermChrome>
    </div>
  );
}

function Rule({ children }: { children: ReactNode }) {
  return (
    <Line
      style={{
        borderTop: "1px solid rgba(143, 136, 124, 0.35)",
        marginTop: "0.45em",
        paddingTop: "0.45em",
        minHeight: "2em",
      }}
    >
      {children}
    </Line>
  );
}

function Key({ k, label }: { k: string; label: string }) {
  return (
    <>
      <b style={{ color: C.brand }}>{k}</b>
      <span style={{ color: C.muted }}> {label}</span>
    </>
  );
}

function summarize(rows: RowState[]): { label: string; color: string }[] {
  const counts = new Map<Status, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const order: Status[] = [
    "creating",
    "updating",
    "pending",
    "created",
    "updated",
    "no change",
  ];
  return order
    .filter((s) => counts.has(s))
    .map((s) => ({
      label: `${counts.get(s)} ${s}`,
      color: statusColor(s),
    }));
}
