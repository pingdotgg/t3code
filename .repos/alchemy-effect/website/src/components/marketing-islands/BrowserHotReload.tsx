import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Line, sleep, TermChrome, useSpinner } from "./_terminal";

/* ────────────────────────────────────────────────────────────
 * Choreography
 *
 * A single state machine drives both the terminal log on the
 * right and the rendered "page" inside the pseudo-browser on the
 * left, so the two stay in lock-step (the user sees the cause
 * and the effect).
 * ──────────────────────────────────────────────────────────── */

type Phase =
  /** initial bring-up of the stack */
  | "boot-photos"
  | "boot-sessions"
  | "boot-api"
  | "ready-v1"
  /** edit src/Api.ts → worker reloads, page rerenders with new copy */
  | "edit-api"
  | "reload-api"
  | "request-hello"
  | "ready-v2"
  /** edit alchemy.run.ts → new Queue resource wired to Api */
  | "edit-stack"
  | "diff-queue"
  | "wire-queue"
  | "ready-v3";

const PHASES: { phase: Phase; ms: number }[] = [
  { phase: "boot-photos", ms: 600 },
  { phase: "boot-sessions", ms: 500 },
  { phase: "boot-api", ms: 700 },
  { phase: "ready-v1", ms: 1300 },
  { phase: "edit-api", ms: 1000 },
  { phase: "reload-api", ms: 600 },
  { phase: "request-hello", ms: 900 },
  { phase: "ready-v2", ms: 1600 },
  { phase: "edit-stack", ms: 1100 },
  { phase: "diff-queue", ms: 700 },
  { phase: "wire-queue", ms: 700 },
  { phase: "ready-v3", ms: 2000 },
];

/* ────────────────────────────────────────────────────────────
 * Terminal log driven by phase
 * ──────────────────────────────────────────────────────────── */

interface LogLine {
  text: ReactNode;
  key: string;
}

let _id = 0;
const mkLine = (text: ReactNode): LogLine => ({ text, key: `${++_id}` });

function bootLine(label: string, detail: string) {
  return mkLine(
    <>
      <span style={{ color: "var(--alc-success)" }}>✓ </span>
      <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>
        {label}
      </span>
      <span style={{ color: "var(--alc-code-comment)" }}>{` (${detail})`}</span>
      <span style={{ color: "var(--alc-success)" }}> created</span>
    </>,
  );
}

const READY_LINES: LogLine[] = [
  mkLine(
    <>
      <span style={{ color: "var(--alc-code-comment)" }}> → </span>
      <span style={{ color: "var(--alc-accent-bright)" }}>
        http://localhost:1337
      </span>
    </>,
  ),
  mkLine(
    <span style={{ color: "var(--alc-code-comment)" }}>
      Watching for changes…
    </span>,
  ),
];

function editLine(file: string) {
  return mkLine(
    <>
      <span style={{ color: "var(--alc-warn)" }}>↻ </span>
      <span style={{ color: "var(--alc-code-comment)" }}>{file} changed</span>
    </>,
  );
}

const RELOAD_LINE = mkLine(
  <>
    <span style={{ color: "var(--alc-success)" }}>✓ </span>
    <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>Api</span>
    <span style={{ color: "var(--alc-code-comment)" }}>{` reloaded in `}</span>
    <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>38ms</span>
  </>,
);

function requestLine() {
  return mkLine(
    <>
      <span
        style={{ color: "var(--alc-code-comment)" }}
      >{`[${new Date().toLocaleTimeString().slice(0, 8)}] `}</span>
      <span style={{ color: "var(--alc-fg-invert)" }}>
        GET /object/hello.txt
      </span>
      <span style={{ color: "var(--alc-success)" }}> 200</span>
    </>,
  );
}

const DIFF_LINE = mkLine(
  <>
    <span style={{ color: "var(--alc-success)" }}>+ </span>
    <span style={{ color: "var(--alc-fg-invert)", fontWeight: 600 }}>
      Queue
    </span>
    <span
      style={{ color: "var(--alc-code-comment)" }}
    >{` (Cloudflare.Queues.Queue)`}</span>
    <span style={{ color: "var(--alc-success)" }}> created</span>
  </>,
);

const WIRE_LINE = mkLine(
  <>
    <span style={{ color: "var(--alc-warn)" }}>~ </span>
    <span style={{ color: "var(--alc-code-comment)" }}>wired </span>
    <span style={{ color: "var(--alc-code-type)" }}>Api → Queue.bind</span>
  </>,
);

const PROMPT_LINE = mkLine(
  <>
    <span style={{ color: "var(--alc-code-comment)" }}>$ </span>
    <span>alchemy dev</span>
  </>,
);

/* ────────────────────────────────────────────────────────────
 * Browser preview (the "rendered site")
 * ──────────────────────────────────────────────────────────── */

type AppVersion = "v1" | "v2" | "v3";

function appVersionFor(phase: Phase): AppVersion {
  switch (phase) {
    case "ready-v1":
    case "edit-api":
      return "v1";
    case "reload-api":
    case "request-hello":
    case "ready-v2":
    case "edit-stack":
    case "diff-queue":
      return "v2";
    case "wire-queue":
    case "ready-v3":
      return "v3";
    default:
      return "v1";
  }
}

function isReloading(phase: Phase) {
  // Worker is rebuilding (or app hasn't booted yet).
  return (
    phase === "boot-photos" ||
    phase === "boot-sessions" ||
    phase === "boot-api" ||
    phase === "reload-api" ||
    phase === "wire-queue"
  );
}

function isBooting(phase: Phase) {
  return (
    phase === "boot-photos" || phase === "boot-sessions" || phase === "boot-api"
  );
}

function PhotoTile({ label }: { label: string }) {
  return (
    <div className="bhr-tile">
      <div className="bhr-tile__img" aria-hidden />
      <div className="bhr-tile__label">{label}</div>
    </div>
  );
}

function PreviewApp({ version }: { version: AppVersion }) {
  const heading = version === "v1" ? "Photos" : "Hello, photos";
  return (
    <div className="bhr-app" key={version}>
      <header className="bhr-app__header">
        <div>
          <div className="bhr-app__eyebrow">my-app · cloudflare workers</div>
          <h3 className="bhr-app__title">{heading}</h3>
        </div>
        {version === "v3" && (
          <button type="button" className="bhr-app__btn">
            + Send to Queue
          </button>
        )}
      </header>
      <div className="bhr-app__grid">
        <PhotoTile label="hello.txt" />
        <PhotoTile label="sunset.jpg" />
        <PhotoTile label="forest.png" />
        <PhotoTile label="diner.heic" />
      </div>
      {version === "v3" && (
        <div className="bhr-app__footer">
          <span className="bhr-app__chip">
            queue: <strong>uploads</strong>
          </span>
          <span className="bhr-app__chip">
            bucket: <strong>Photos</strong>
          </span>
          <span className="bhr-app__chip">
            kv: <strong>Sessions</strong>
          </span>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────
 * Browser chrome
 * ──────────────────────────────────────────────────────────── */

function BrowserChrome({
  reloading,
  children,
  style,
}: {
  reloading: boolean;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className="bhr-browser" style={style}>
      <div className="bhr-browser__header">
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
        <div className="bhr-browser__nav" aria-hidden>
          <span className="bhr-browser__navbtn">‹</span>
          <span className="bhr-browser__navbtn">›</span>
          <span
            className={
              "bhr-browser__navbtn bhr-browser__reload" +
              (reloading ? " is-spinning" : "")
            }
          >
            ↻
          </span>
        </div>
        <div className="bhr-browser__url">
          <span className="bhr-browser__lock" aria-hidden>
            ●
          </span>
          <span className="bhr-browser__urlhost">localhost</span>
          <span className="bhr-browser__urlmuted">:1337/</span>
          <span style={{ flex: 1 }} />
          <span className="bhr-browser__hmr">
            <span className="bhr-browser__hmrdot" /> HMR
          </span>
        </div>
      </div>
      <div className="bhr-browser__body">
        {reloading && <div className="bhr-browser__progress" aria-hidden />}
        {children}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────
 * Main component
 * ──────────────────────────────────────────────────────────── */

export default function BrowserHotReload() {
  const [phase, setPhase] = useState<Phase>("boot-photos");
  const [lines, setLines] = useState<LogLine[]>([PROMPT_LINE]);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    cancelRef.current = false;
    const aborted = () => cancelRef.current;

    const push = (...newLines: LogLine[]) =>
      setLines((ls) => [...ls, ...newLines].slice(-14));

    const reset = () => {
      setLines([PROMPT_LINE]);
    };

    const run = async () => {
      while (!aborted()) {
        reset();
        setPhase("boot-photos");
        await sleep(300);

        for (const { phase: next, ms } of PHASES) {
          if (aborted()) return;
          setPhase(next);

          // Show the spinner during clearly "busy" steps so the
          // browser progress bar and the terminal feel coupled.
          const showSpinner =
            isBooting(next) || next === "reload-api" || next === "wire-queue";
          setBusy(showSpinner);
          await sleep(ms);
          setBusy(false);

          switch (next) {
            case "boot-photos":
              push(bootLine("Photos", "Cloudflare.R2.Bucket"));
              break;
            case "boot-sessions":
              push(bootLine("Sessions", "Cloudflare.KV.Namespace"));
              break;
            case "boot-api":
              push(bootLine("Api", "Cloudflare.Worker · local → workerd"));
              break;
            case "ready-v1":
            case "ready-v2":
            case "ready-v3":
              push(...READY_LINES.map((l) => mkLine(l.text)));
              break;
            case "edit-api":
              push(editLine("src/Api.ts"));
              break;
            case "reload-api":
              push(RELOAD_LINE);
              break;
            case "request-hello":
              push(requestLine());
              break;
            case "edit-stack":
              push(editLine("alchemy.run.ts"));
              break;
            case "diff-queue":
              push(DIFF_LINE);
              break;
            case "wire-queue":
              push(WIRE_LINE);
              break;
          }
        }

        await sleep(1800);
      }
    };

    run();
    return () => {
      cancelRef.current = true;
    };
  }, []);

  const spinner = useSpinner(busy);
  const reloading = isReloading(phase);
  const version = appVersionFor(phase);
  const booting = isBooting(phase);

  return (
    <div className="bhr-stage">
      {/* Browser preview — hidden on small screens */}
      <BrowserChrome reloading={reloading} style={{ minWidth: 0 }}>
        {booting ? (
          <div className="bhr-app bhr-app--boot">
            <div className="bhr-app__skeleton" />
            <div className="bhr-app__skeleton bhr-app__skeleton--sm" />
            <div className="bhr-app__grid">
              <div className="bhr-tile bhr-tile--ghost" />
              <div className="bhr-tile bhr-tile--ghost" />
              <div className="bhr-tile bhr-tile--ghost" />
              <div className="bhr-tile bhr-tile--ghost" />
            </div>
          </div>
        ) : (
          <PreviewApp version={version} />
        )}
      </BrowserChrome>

      {/* Terminal — always visible */}
      <div className="bhr-term">
        <TermChrome
          title="~/my-app"
          badge="DEV"
          badgeColor="var(--alc-accent-bright)"
          maxLines={15}
        >
          {lines.map((l) => (
            <Line key={l.key}>{l.text}</Line>
          ))}
          {busy && (
            <Line>
              <span style={{ color: "var(--alc-code-comment)" }}>
                {spinner}{" "}
              </span>
            </Line>
          )}
        </TermChrome>
      </div>
    </div>
  );
}
