import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { prefersReducedMotion, useSpinner } from "./_terminal";
import { yantraSvg } from "../../brand/yantra";
import "./PRLifecycle.css";

/*
 * PR preview lifecycle, mirroring the CI workflow in the Cloudflare
 * tutorial (part 5): a pull request deploys `--stage pr-N` and tests it,
 * the stack posts the preview URL as a PR comment, and merging runs the
 * `prod` deploy and the preview cleanup in parallel.
 *
 * Left: the pull request, whose checks box expands to show the tests while
 * they run. Right: GitHub Actions, which expands the active step's log the
 * way GitHub does.
 *
 * Every frame is derived from (step, ms elapsed in that step), so any step
 * can be jumped to directly from the tab bar.
 */

type StepId = "open" | "deploy" | "test" | "merge";
type Status = "queued" | "running" | "success";

const STEPS: { id: StepId; label: string; ms: number }[] = [
  { id: "open", label: "PR opened", ms: 2600 },
  { id: "deploy", label: "Deploy", ms: 14550 },
  { id: "test", label: "Test", ms: 10500 },
  { id: "merge", label: "Merge", ms: 11300 },
];

const PR = 147;
const STAGE = `pr-${PR}`;
const HOST = `${STAGE}.my-app.workers.dev`;
const RESOURCES = [
  { id: "Photos", type: "Cloudflare.R2.Bucket" },
  { id: "Sessions", type: "Cloudflare.KV.Namespace" },
  { id: "Api", type: "Cloudflare.Worker" },
  { id: "PreviewComment", type: "GitHub.Comment" },
];
const PREVIEW_STEPS = [
  "Checkout",
  "Setup runtime",
  "Install dependencies",
  `alchemy deploy --stage ${STAGE}`,
];
const TEST_STEPS = [
  "Checkout",
  "Setup runtime",
  "Install dependencies",
  "alchemy test",
];
const PROD_STEPS = [
  "Checkout",
  "Setup runtime",
  "Install dependencies",
  "alchemy deploy --stage prod",
];
const CLEANUP_STEPS = [
  "Checkout",
  "Setup runtime",
  "Install dependencies",
  `alchemy destroy --stage ${STAGE}`,
];

// Anything outside the deploy/test/destroy work (job setup, clicks, tab
// open/close) runs just fast enough to read. Every job's Checkout, Setup
// runtime and Install dependencies finish at these offsets from its start.
const SETUP_DONE = [450, 850, 1250];
// Each step holds ~1s on its finished frame before moving on.

// PR opened: the preview job picks up and runs its setup steps.
const T_JOB_START = 300;
const T_SETUP_DONE = SETUP_DONE.map((x) => x + T_JOB_START);
// The deploy, test and destroy logs run in real time, from one measured
// run of examples/cloudflare-preview-benchmark (alchemy 2.0.0-beta.79):
// deploy 13.35s, URL live 0.94s, test 4.83s, destroy 4.76s. The GitHub
// comment was not part of that run; its ~0.35s create/delete is estimated.
// Row spans are in RESOURCES order: Photos, Sessions, Api, PreviewComment.

// Deploy: CLI start + plan 3.35s, then Sessions 0.62s, Photos 3.3s, and Api
// 9.9s (it waits for Photos, then bundles and uploads). The ~0.94s hold at
// the end is the time until the preview URL answered.
const T_PLAN = 3350;
const T_ROWS = [
  [3350, 6650],
  [3350, 3970],
  [3350, 13250],
  [13250, 13600],
] as const;
const T_COMMENT = T_ROWS[3][1];
const T_DEPLOYED = 13600;
// What the CLI is doing before the plan prints, and what Api is waiting on.
// These only label time already inside the measured totals.
const DEPLOY_PREP: Phase[] = [
  { at: 150, label: "loading alchemy.run.ts" },
  { at: 1150, label: `reading state · ${STAGE}` },
  { at: 1400, label: "planning 4 resources" },
];
const API_PHASES: Phase[] = [
  { at: 3350, label: "waiting for Photos" },
  { at: 6650, label: "bundling src/api.ts" },
  { at: 8850, label: "uploading worker" },
  { at: 12150, label: "enabling workers.dev" },
];
// Test: a separate job that needs the preview. Its setup steps run, then
// `alchemy test` opens the preview in a browser tab, drives it, and closes it.
// The run takes 4.83s: ~4.0s for the harness to confirm the stack is up to
// date (real time), then three tests of 272ms, 273ms and 284ms. Those would
// only flash by, so each is shown at TEST_SLOWDOWN× and labeled as such.
const TEST_SLOWDOWN = 4;
const T_TEST_SETUP = SETUP_DONE;
const T_TEST_EXPAND = SETUP_DONE[2]! + 100;
const T_HARNESS_DONE = T_TEST_EXPAND + 4000;
const TEST_MS = [272, 273, 284];
const T_TESTS = TEST_MS.reduce<[number, number][]>((acc, ms) => {
  const start = acc.length ? acc[acc.length - 1]![1] : T_HARNESS_DONE;
  return [...acc, [start, start + ms * TEST_SLOWDOWN]];
}, []);
const T_TESTS_DONE = T_TESTS[2]![1];
const T_TAB_OPEN = T_TESTS[0]![0] - 400;
const T_PAGE_LOADED = T_TESTS[0]![0] + 200;
const T_TAB_CLOSE = T_TESTS_DONE + 500;
const T_TAB_GONE = T_TAB_CLOSE + 360;
// Merge: the prod deploy and the preview cleanup start together and run
// side by side; cleanup's destroy log is the one expanded. The prod stage
// already exists, so its deploy is an update (measured median 7.6s).
const T_MERGE_CLICK = 900;
const T_MERGED = 1300;
const T_JOBS_SETUP_DONE = T_MERGED + SETUP_DONE[2]!;
const T_PROD_DONE = T_JOBS_SETUP_DONE + 7600;
// Destroy log timings below are relative to T_DESTROY_BASE. The comment
// depends on the Worker's URL, so it is deleted first.
const T_EXPAND = 250;
const T_DESTROY_BASE = T_JOBS_SETUP_DONE - T_EXPAND;
// Destroy (4.76s + comment): CLI start + plan 2.4s, comment 0.35s, then Api
// 1.0s, Photos 1.2s (emptied first) and Sessions 2.0s in parallel.
const T_DESTROY_PLAN = T_EXPAND + 2400;
const T_DEL_ROWS = [
  [T_DESTROY_PLAN + 350, T_DESTROY_PLAN + 1550],
  [T_DESTROY_PLAN + 350, T_DESTROY_PLAN + 2350],
  [T_DESTROY_PLAN + 350, T_DESTROY_PLAN + 1350],
  [T_DESTROY_PLAN, T_DESTROY_PLAN + 350],
] as const;
const T_COMMENT_DELETED = T_DEL_ROWS[3][1];
const T_DESTROYED = T_EXPAND + 4760 + 350;
const DESTROY_PREP: Phase[] = [
  { at: T_EXPAND + 150, label: "loading alchemy.run.ts" },
  { at: T_EXPAND + 1150, label: `reading state · ${STAGE}` },
  { at: T_EXPAND + 1400, label: "planning deletes" },
];

const GREEN = "var(--alc-accent-bright)";
// The alchemy bot's avatar is the brand mark (windows are always dark).
const BOT_LOGO = yantraSvg({ size: 16, theme: "dark" });

type Phase = { at: number; label: string };
/** The label of the latest phase that has started, or undefined. */
const phaseAt = (phases: Phase[], t: number) =>
  [...phases].reverse().find((p) => t >= p.at)?.label;
/** Seconds since `from`, ticking so long waits visibly move. */
const secs = (t: number, from: number) =>
  `${Math.max(0, (t - from) / 1000).toFixed(1)}s`;

/** While paused, spinners hold their frame like everything else. */
const PausedContext = createContext(false);
function useSpin(active: boolean) {
  const paused = useContext(PausedContext);
  return useSpinner(active && !paused);
}
const RED = "var(--alc-danger)";

export default function PRLifecycle() {
  const [step, setStep] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(
    null,
  );

  // Slide the highlight under the active tab.
  useLayoutEffect(() => {
    const measure = () => {
      const tab = tabsRef.current?.children[step] as HTMLElement | undefined;
      if (tab) setPill({ left: tab.offsetLeft, width: tab.offsetWidth });
    };
    measure();
    addEventListener("resize", measure);
    return () => removeEventListener("resize", measure);
  }, [step]);

  // On narrow screens the tab row scrolls sideways; keep the active tab
  // centered in it (without scrolling the page).
  useEffect(() => {
    const row = tabsRef.current;
    const tab = row?.children[step] as HTMLElement | undefined;
    if (!row || !tab || row.scrollWidth <= row.clientWidth) return;
    row.scrollTo({
      left:
        row.scrollLeft +
        tab.getBoundingClientRect().left -
        row.getBoundingClientRect().left -
        (row.clientWidth - tab.offsetWidth) / 2,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [step]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    // Don't auto-advance for reduced motion; the steps and play stay usable.
    if (mq.matches) setPlaying(false);
    const el = rootRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => setVisible(!!e?.isIntersecting),
      { threshold: 0.25 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // The clock runs only while playing and on screen, so pausing freezes the
  // animation mid-step.
  useEffect(() => {
    if (!visible || !playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      setElapsed((e) => e + dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible, playing]);

  const dur = STEPS[step]!.ms;
  useEffect(() => {
    if (elapsed < dur) return;
    setStep((s) => (s + 1) % STEPS.length);
    setElapsed(0);
  }, [elapsed, dur]);

  // Jump to the start of a step; playback state is unchanged.
  const go = (i: number) => {
    setStep(i);
    setElapsed(0);
  };
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next =
      (step + (e.key === "ArrowRight" ? 1 : -1) + STEPS.length) % STEPS.length;
    go(next);
    rootRef.current
      ?.querySelectorAll<HTMLButtonElement>(".prf-tab")
      [next]?.focus();
  };

  // Reduced motion: show each step's finished frame.
  const t = reduced ? dur : Math.min(elapsed, dur);
  const id = STEPS[step]!.id;

  const previewStatus: Status =
    id === "open"
      ? t < T_JOB_START
        ? "queued"
        : "running"
      : id === "deploy" && t < T_DEPLOYED
        ? "running"
        : "success";
  const testStatus: Status | null =
    id === "open" || id === "deploy"
      ? null
      : id === "test"
        ? t < T_TEST_SETUP[0]!
          ? "queued"
          : t < T_TESTS_DONE
            ? "running"
            : "success"
        : "success";
  const merged = id === "merge" && t >= T_MERGED;
  const td = t - T_DESTROY_BASE;
  const cleanupStatus: Status | null = !merged
    ? null
    : td >= T_DESTROYED
      ? "success"
      : "running";
  const showComment =
    (id === "deploy" && t >= T_COMMENT) ||
    id === "test" ||
    (id === "merge" && td < T_COMMENT_DELETED);

  return (
    <PausedContext.Provider value={!playing}>
      <div
        className={`prf ${playing ? "" : "is-paused"}`}
        ref={rootRef}
        data-nosnippet=""
      >
        <div className="prf-tabs-row">
          <div
            className="prf-tabs"
            ref={tabsRef}
            role="tablist"
            aria-label="Pull request lifecycle"
          >
            {STEPS.map((s, i) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                id={`prf-tab-${s.id}`}
                aria-controls="prf-panel"
                aria-selected={i === step}
                tabIndex={i === step ? 0 : -1}
                className={`prf-tab ${i === step ? "is-active" : i < step ? "is-done" : ""}`}
                onClick={() => go(i)}
                onKeyDown={onTabKey}
              >
                <span className="prf-tab__num">{i + 1}</span>
                <span className="prf-tab__label">{s.label}</span>
              </button>
            ))}
            <span className="prf-tabs__track" aria-hidden>
              <span
                className="prf-tabs__progress"
                style={{
                  transform: `scaleX(${(step + Math.min(elapsed, dur) / dur) / STEPS.length})`,
                }}
              />
            </span>
            {pill && (
              <span
                className="prf-tabs__pill"
                aria-hidden
                style={{ left: pill.left, width: pill.width }}
              />
            )}
          </div>
          <button
            type="button"
            className="prf-play"
            onClick={() => setPlaying((p) => !p)}
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause" : "Play"}
          >
            {playing ? (
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                <rect x="2" y="1.5" width="2.6" height="9" rx="0.8" />
                <rect x="7.4" y="1.5" width="2.6" height="9" rx="0.8" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                <path d="M3 1.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1l-7-4.4a.6.6 0 0 0-.9.5Z" />
              </svg>
            )}
          </button>
        </div>

        <div
          className="prf-stage"
          id="prf-panel"
          role="tabpanel"
          aria-labelledby={`prf-tab-${id}`}
        >
          <div className="prf-side">
            <PullRequest
              id={id}
              t={t}
              merged={merged}
              previewStatus={previewStatus}
              testStatus={testStatus}
              cleanupStatus={cleanupStatus}
              showComment={showComment}
              tab={
                id === "test" && t >= T_TAB_OPEN && t < T_TAB_GONE
                  ? { t, closing: t >= T_TAB_CLOSE }
                  : null
              }
            />
          </div>
          <div className="prf-right">
            <Actions id={id} t={t} />
          </div>
        </div>
      </div>
    </PausedContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function Win({
  title,
  badge,
  children,
  className = "",
}: {
  title: ReactNode;
  badge?: { text: string; tone: "green" | "red" | "sky" };
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`prf-win ${className}`}>
      <div className="prf-win__bar">
        <span className="prf-dot" style={{ background: "var(--alc-danger)" }} />
        <span className="prf-dot" style={{ background: "var(--alc-warn)" }} />
        <span className="prf-dot" style={{ background: GREEN }} />
        <span className="prf-win__title">{title}</span>
        {badge && (
          <span className={`prf-badge prf-badge--${badge.tone}`}>
            {badge.text}
          </span>
        )}
      </div>
      <div className="prf-win__body">{children}</div>
    </div>
  );
}

function StatusIcon({ status }: { status: Status }) {
  const spin = useSpin(status === "running");
  if (status === "success")
    return (
      <span className="prf-si prf-si--ok" role="img" aria-label="passed">
        <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden>
          <path
            // Optically centered: the stroke's visual mass (not its box)
            // sits at the circle's center, so the check doesn't read as
            // low-left.
            d="M4 8l3 3 6-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  if (status === "running")
    return (
      <span className="prf-si prf-si--run" role="img" aria-label="running">
        {spin}
      </span>
    );
  return (
    <span className="prf-si prf-si--queued" role="img" aria-label="queued" />
  );
}

/** Animates height between 0 and auto. */
function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={`prf-collapse ${open ? "" : "is-closed"}`}>
      <div>{children}</div>
    </div>
  );
}

/**
 * A step's log. `rows` is the line count it ends with: the space is
 * reserved up front, so the expand animates once and lines fill it in
 * instead of pushing the card taller as they print.
 */
function Log({ lines, rows }: { lines: ReactNode[]; rows: number }) {
  return (
    <div
      className="prf-log"
      style={{
        minHeight: `calc(${rows} * 1.7em + 20px)`,
        boxSizing: "border-box",
      }}
    >
      {lines.map((l, i) => (
        <div className="prf-log__line prf-enter" key={i}>
          <span className="prf-log__n">{i + 1}</span>
          <span className="prf-log__t">{l}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Right: GitHub Actions                                               */
/* ------------------------------------------------------------------ */

/**
 * A job card. Collapsed it is one row; expanded it lists its steps, and
 * opening a step folds the finished ones into a row of checks and shows
 * that step's log.
 */
function Job({
  name,
  sub,
  trigger,
  steps,
  statuses,
  expanded,
  open,
  log,
}: {
  name: string;
  sub: ReactNode;
  trigger?: ReactNode;
  steps: string[];
  statuses: Status[];
  expanded: boolean;
  open: number | null;
  log?: ReactNode;
}) {
  const jobStatus: Status = statuses.every((s) => s === "success")
    ? "success"
    : statuses.some((s) => s !== "queued")
      ? "running"
      : "queued";
  const stepOpen = expanded && open !== null;
  return (
    <div className={`prf-job prf-enter ${expanded ? "is-expanded" : ""}`}>
      <div className="prf-job__head">
        <StatusIcon status={jobStatus} />
        <strong>{name}</strong>
        <span className="prf-muted">{sub}</span>
      </div>
      <Collapse open={expanded}>
        <Collapse open={!stepOpen}>
          {trigger && <div className="prf-job__trigger">{trigger}</div>}
          {steps.map((s, i) => (
            <div key={s} className={`prf-job__step is-${statuses[i]}`}>
              <StatusIcon status={statuses[i]!} />
              <span>{s}</span>
            </div>
          ))}
        </Collapse>
        <Collapse open={stepOpen}>
          {stepOpen && (
            <>
              <div className="prf-job__done">
                {statuses.slice(0, open).map((s, i) => (
                  <StatusIcon key={i} status={s} />
                ))}
                <span className="prf-muted">{open} steps</span>
              </div>
              <div className="prf-xstep" key={open}>
                <div className="prf-xstep__head">
                  <StatusIcon status={statuses[open]!} />
                  <span>{steps[open]}</span>
                  <svg
                    className="prf-xstep__chev"
                    viewBox="0 0 16 16"
                    width="14"
                    height="14"
                    aria-hidden
                  >
                    <path
                      d="m4 6 4 4 4-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
                {log}
              </div>
            </>
          )}
        </Collapse>
      </Collapse>
    </div>
  );
}

const ALL_DONE: Status[] = ["success", "success", "success", "success"];

/** Setup steps finish at the given times, then the last step runs. */
function stepStatuses(
  t: number,
  setupDone: number[],
  lastDone: number,
): Status[] {
  const starts = [0, ...setupDone];
  return [0, 1, 2, 3].map((i) =>
    i < 3
      ? t >= setupDone[i]!
        ? "success"
        : t >= starts[i]!
          ? "running"
          : "queued"
      : t >= lastDone
        ? "success"
        : t >= setupDone[2]!
          ? "running"
          : "queued",
  );
}

/**
 * The whole run history as one continuous list: jobs appear when they are
 * triggered, the active job expands, and finished jobs collapse to a row.
 */
function Actions({ id, t }: { id: StepId; t: number }) {
  const listRef = useRef<HTMLDivElement>(null);
  // Follow the newest job while cards expand and collapse.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const preview: Status[] =
    id === "open"
      ? stepStatuses(
          t,
          T_SETUP_DONE.map((x) => x),
          Infinity,
        ).map((s, i) => (i === 0 && t < T_JOB_START ? "queued" : s))
      : id === "deploy"
        ? [
            "success",
            "success",
            "success",
            t < T_DEPLOYED ? "running" : "success",
          ]
        : ALL_DONE;
  const test: Status[] =
    id === "test" ? stepStatuses(t, T_TEST_SETUP, T_TESTS_DONE) : ALL_DONE;
  const afterMerge = id === "merge" && t >= T_MERGED;
  const td = t - T_DESTROY_BASE;
  const m = t - T_MERGED;
  const prod: Status[] =
    id === "merge"
      ? stepStatuses(m, SETUP_DONE, T_PROD_DONE - T_MERGED)
      : ALL_DONE;
  const cleanup: Status[] = stepStatuses(
    m,
    SETUP_DONE,
    T_DESTROYED + T_DESTROY_BASE - T_MERGED,
  );

  const badge =
    id === "open"
      ? ({ text: "PULL_REQUEST", tone: "sky" } as const)
      : id === "deploy"
        ? ({ text: "DEPLOY", tone: "green" } as const)
        : id === "test"
          ? ({ text: "TEST", tone: "green" } as const)
          : ({ text: "MERGE", tone: "sky" } as const);

  return (
    <Win title="Actions · acme/my-app" badge={badge}>
      <div className="prf-jobs" ref={listRef}>
        <Job
          name="preview"
          sub={<>pull_request · {STAGE}</>}
          trigger={
            <>
              <span className="prf-muted">on:</span> pull_request{" "}
              <span className="prf-muted">(opened) ·</span> STAGE=
              <span className="prf-hl">{STAGE}</span>
            </>
          }
          steps={PREVIEW_STEPS}
          statuses={preview}
          expanded={id === "open" || id === "deploy"}
          open={id === "deploy" ? 3 : null}
          log={id === "deploy" ? <DeployLog t={t} /> : undefined}
        />
        {id !== "open" && id !== "deploy" && (
          <Job
            name="test"
            sub={<>needs: preview</>}
            trigger={
              <>
                <span className="prf-muted">env:</span> PREVIEW_URL=
                <span className="prf-hl">https://{HOST}</span>
              </>
            }
            steps={TEST_STEPS}
            statuses={test}
            expanded={id === "test"}
            open={id === "test" && t >= T_TEST_EXPAND ? 3 : null}
            log={id === "test" ? <TestLog t={t} /> : undefined}
          />
        )}
        {afterMerge && (
          <Job
            name="deploy"
            sub={
              <>
                push · <span className="prf-hl">prod</span>
              </>
            }
            steps={PROD_STEPS}
            statuses={prod}
            expanded={false}
            open={null}
          />
        )}
        {afterMerge && (
          <Job
            name="cleanup"
            sub={<>pull_request closed · {STAGE}</>}
            steps={CLEANUP_STEPS}
            statuses={cleanup}
            expanded
            open={td >= T_EXPAND ? 3 : null}
            log={<DestroyLog t={td} />}
          />
        )}
        {id === "merge" && !afterMerge && (
          <div className="prf-jobs__wait prf-muted">Waiting for merge…</div>
        )}
      </div>
    </Win>
  );
}

function ResourceLine({
  r,
  t,
  span,
  verb,
  tone,
  spin,
  phases,
}: {
  r: (typeof RESOURCES)[number];
  t: number;
  span: readonly [number, number];
  verb: "create" | "delete";
  tone: string;
  spin: string;
  phases?: Phase[];
}) {
  const [a, b] = span;
  const done = t >= b;
  const busy = t >= a && !done;
  return (
    <>
      <span className="prf-log__icon" style={{ color: tone }}>
        {done ? "✓" : busy ? spin : verb === "create" ? "+" : "-"}
      </span>
      <span className="prf-strong">{r.id}</span>
      <span className="prf-muted"> ({r.type})</span>
      {(busy || done) && (
        <span style={{ color: tone }}>
          {" "}
          {verb === "create"
            ? done
              ? "created"
              : "creating"
            : done
              ? "deleted"
              : "deleting"}
        </span>
      )}
      {busy && (
        <span className="prf-muted">
          {" · "}
          {phases ? `${phaseAt(phases, t)} ` : ""}
          {secs(t, a)}
        </span>
      )}
    </>
  );
}

/** One line that narrates the CLI's prep, then settles on a summary. */
function PrepLine({
  t,
  start,
  end,
  phases,
  tone,
}: {
  t: number;
  start: number;
  end: number;
  phases: Phase[];
  tone: string;
}) {
  const spin = useSpin(t < end);
  const done = t >= end;
  return (
    <>
      <span className="prf-log__icon" style={{ color: tone }}>
        {done ? "✓" : spin}
      </span>
      {done ? (
        <>
          planned <span className="prf-muted">· {secs(end, start)}</span>
        </>
      ) : (
        <>
          {phaseAt(phases, t)}
          <span className="prf-muted"> · {secs(t, start)}</span>
        </>
      )}
    </>
  );
}

function DeployLog({ t }: { t: number }) {
  const spin = useSpin(T_ROWS.some(([a, b]) => t >= a && t < b));
  const lines: ReactNode[] = [
    <>
      <span className="prf-muted">$ </span>alchemy deploy --stage {STAGE} --yes
    </>,
  ];
  if (t >= DEPLOY_PREP[0]!.at)
    lines.push(
      <PrepLine
        t={t}
        start={0}
        end={T_PLAN}
        phases={DEPLOY_PREP}
        tone={GREEN}
      />,
    );
  if (t >= T_PLAN) {
    lines.push(
      <>
        <span className="prf-u" style={{ color: GREEN }}>
          Apply
        </span>
        : <span style={{ color: "var(--alc-success)" }}>4 to create</span>
      </>,
    );
    RESOURCES.forEach((r, i) =>
      lines.push(
        <ResourceLine
          r={r}
          t={t}
          span={T_ROWS[i]!}
          verb="create"
          tone={GREEN}
          spin={spin}
          phases={r.id === "Api" ? API_PHASES : undefined}
        />,
      ),
    );
  }
  if (t >= T_DEPLOYED) {
    lines.push(
      <>
        <span style={{ color: GREEN }}>✓ </span>deployed in{" "}
        <span className="prf-strong">13.6s</span>
      </>,
      <>
        <span className="prf-muted">{"  → "}</span>
        <span style={{ color: "var(--alc-code-type)" }}>https://{HOST}</span>
      </>,
    );
  }
  return <Log lines={lines} rows={9} />;
}

const TESTS = [
  { name: "GET /photos renders the gallery", ms: "272ms" },
  { name: "uploads a photo to R2", ms: "273ms" },
  { name: "session survives a reload", ms: "284ms" },
];

function TestLog({ t }: { t: number }) {
  const spin = useSpin(T_TESTS.some(([a, b]) => t >= a && t < b));
  const checkSpin = useSpin(t < T_TESTS[0]![0]);
  const lines: ReactNode[] = [
    <>
      <span className="prf-muted">$ </span>alchemy test test/preview.test.ts
    </>,
    <span className="prf-muted">
      PREVIEW_URL=<span className="prf-hl">https://{HOST}</span>
    </span>,
    <>
      <span className="prf-log__icon" style={{ color: GREEN }}>
        {t >= T_TESTS[0]![0] ? "✓" : checkSpin}
      </span>
      stack {STAGE}
      <span className="prf-muted">
        {t >= T_TESTS[0]![0] ? " · up to date" : " · checking for changes"}
      </span>
    </>,
  ];
  TESTS.forEach((x, i) => {
    const [a, b] = T_TESTS[i]!;
    if (t < a) return;
    lines.push(
      <>
        <span className="prf-log__icon" style={{ color: GREEN }}>
          {t >= b ? "✓" : spin}
        </span>
        <span className={t >= b ? "prf-strong" : undefined}>{x.name}</span>
        {t >= b && <span className="prf-muted"> [{x.ms}]</span>}
      </>,
    );
  });
  if (t >= T_TESTS[0]![0] && t < T_TESTS_DONE) {
    lines.push(
      <span className="prf-muted">
        {"  "}(slowed down {TEST_SLOWDOWN}× so you can watch)
      </span>,
    );
  }
  if (t >= T_TESTS_DONE) {
    lines.push(
      <>
        <span style={{ color: GREEN }}>3 pass</span>
        <span className="prf-muted"> · </span>0 fail
        <span className="prf-muted"> · 4.8s</span>
      </>,
    );
  }
  return <Log lines={lines} rows={7} />;
}

function DestroyLog({ t }: { t: number }) {
  const spin = useSpin(T_DEL_ROWS.some(([a, b]) => t >= a && t < b));
  const lines: ReactNode[] = [
    <>
      <span className="prf-muted">$ </span>alchemy destroy --stage {STAGE} --yes
    </>,
  ];
  if (t >= DESTROY_PREP[0]!.at)
    lines.push(
      <PrepLine
        t={t}
        start={T_EXPAND}
        end={T_DESTROY_PLAN}
        phases={DESTROY_PREP}
        tone={RED}
      />,
    );
  if (t >= T_DESTROY_PLAN) {
    lines.push(
      <>
        <span className="prf-u" style={{ color: RED }}>
          Apply
        </span>
        : <span style={{ color: RED }}>4 to delete</span>
      </>,
    );
    RESOURCES.forEach((r, i) =>
      lines.push(
        <ResourceLine
          r={r}
          t={t}
          span={T_DEL_ROWS[i]!}
          verb="delete"
          tone={RED}
          spin={spin}
        />,
      ),
    );
  }
  if (t >= T_DESTROYED) {
    lines.push(
      <>
        <span style={{ color: RED }}>✓ </span>destroyed in{" "}
        <span className="prf-strong">5.1s</span>
        <span className="prf-muted"> · nothing left running</span>
      </>,
    );
  }
  return <Log lines={lines} rows={8} />;
}

/* ------------------------------------------------------------------ */
/* Left: the pull request                                              */
/* ------------------------------------------------------------------ */

function checkLabel(s: Status) {
  return s === "queued"
    ? "Queued"
    : s === "running"
      ? "In progress"
      : "Successful";
}

function PullRequest({
  id,
  t,
  merged,
  previewStatus,
  testStatus,
  cleanupStatus,
  showComment,
  tab,
}: {
  id: StepId;
  t: number;
  tab: { t: number; closing: boolean } | null;
  merged: boolean;
  previewStatus: Status;
  testStatus: Status | null;
  cleanupStatus: Status | null;
  showComment: boolean;
}) {
  // Keep the newest timeline entry in view as the feed grows.
  const feedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = feedRef.current;
    if (el)
      el.scrollTo({
        top: el.scrollHeight,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
  }, [id, merged, showComment, testStatus, cleanupStatus, t >= T_MERGE_CLICK]);

  return (
    <div className="prf-win prf-pr">
      <div className="prf-win__bar prf-win__bar--tabs">
        <span className="prf-dot" style={{ background: "var(--alc-danger)" }} />
        <span className="prf-dot" style={{ background: "var(--alc-warn)" }} />
        <span className="prf-dot" style={{ background: GREEN }} />
        <span className={`prf-btab ${tab ? "" : "is-active"}`}>
          <PrIcon />
          Add image upload… #{PR}
        </span>
        {tab && (
          <span
            className={`prf-btab is-active is-new ${tab.closing ? "is-closing" : ""}`}
          >
            {tab.t < T_PAGE_LOADED && <span className="prf-btab__spin" />}
            Photos · {STAGE}
            <span className="prf-btab__x">×</span>
          </span>
        )}
      </div>
      <div className="prf-win__body">
        <div className="prf-pr__url">github.com/acme/my-app/pull/{PR}</div>
        <div className="prf-pr__head">
          <div className="prf-pr__title">
            Add image upload to /photos{" "}
            <span className="prf-pr__num">#{PR}</span>
          </div>
          <div className="prf-pr__meta">
            <span
              className={`prf-state ${merged ? "prf-state--merged" : "prf-state--open"}`}
            >
              {merged ? <MergeIcon /> : <PrIcon />}
              {merged ? "Merged" : "Open"}
            </span>
            <span className="prf-branch">feature/photo-upload</span>
            <span className="prf-arrow">→</span>
            <span className="prf-branch">main</span>
          </div>
        </div>

        <div className="prf-feed" ref={feedRef}>
          <div className="prf-event">
            <span className="prf-event__icon prf-event__icon--you">you</span>
            <span>
              opened this pull request{" "}
              <span className="prf-muted">· 3 commits</span>{" "}
              <span className="prf-add">+142</span>{" "}
              <span className="prf-del">−8</span>
            </span>
          </div>

          {showComment && (
            <div className="prf-comment prf-enter">
              <div className="prf-comment__head">
                <span
                  className="prf-avatar"
                  aria-hidden
                  dangerouslySetInnerHTML={{ __html: BOT_LOGO }}
                />
                <strong>alchemy</strong>
                <span className="prf-bot">bot</span>
                <span className="prf-muted">commented</span>
              </div>
              <div className="prf-comment__body">
                <div className="prf-comment__h">Preview deployed</div>
                <div className="prf-url">https://{HOST}</div>
                <div className="prf-muted prf-small">
                  Built from <code>a8f3d21</code> · updates with each push
                </div>
              </div>
            </div>
          )}

          {merged && (
            <div className="prf-event prf-enter">
              <span className="prf-event__icon prf-event__icon--merged">
                <MergeIcon />
              </span>
              <span>
                Merged <code>e41c7b9</code> into <code>main</code>
              </span>
            </div>
          )}

          <div className="prf-checks">
            <div className="prf-check">
              <StatusIcon status={previewStatus} />
              <span className="prf-check__name">
                PR <span className="prf-muted">/ preview (pull_request)</span>
              </span>
              <span className="prf-check__state">
                {checkLabel(previewStatus)}
              </span>
            </div>
            {testStatus && (
              <div className="prf-check prf-enter">
                <StatusIcon status={testStatus} />
                <span className="prf-check__name">
                  PR <span className="prf-muted">/ test (pull_request)</span>
                </span>
                <span className="prf-check__state">
                  {checkLabel(testStatus)}
                </span>
              </div>
            )}
            {cleanupStatus && (
              <div className="prf-check prf-enter">
                <StatusIcon status={cleanupStatus} />
                <span className="prf-check__name">
                  PR <span className="prf-muted">/ cleanup (closed)</span>
                </span>
                <span className="prf-check__state">
                  {checkLabel(cleanupStatus)}
                </span>
              </div>
            )}
            {id === "merge" && !merged && (
              <div className="prf-mergebox prf-enter">
                <div className="prf-mergebox__ok">
                  <StatusIcon status="success" /> All checks have passed
                </div>
                <span
                  className={`prf-mergebtn ${t >= T_MERGE_CLICK ? "is-pressed" : ""}`}
                >
                  Merge pull request
                </span>
              </div>
            )}
          </div>
        </div>
        {tab && <SitePage t={tab.t} closing={tab.closing} />}
      </div>
    </div>
  );
}

// Stroke-drawn so the rings, stems and curve render cleanly at 12px.
function PrIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="4" cy="3.5" r="1.7" />
      <circle cx="4" cy="12.5" r="1.7" />
      <circle cx="12" cy="12.5" r="1.7" />
      <path d="M4 5.2v5.6" />
      <path d="M12 10.8V6.5a2 2 0 0 0-2-2H7.5" />
      <path d="M9 3 7.5 4.5 9 6" />
    </svg>
  );
}
function MergeIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="4" cy="3.5" r="1.7" />
      <circle cx="4" cy="12.5" r="1.7" />
      <circle cx="12" cy="8.5" r="1.7" />
      <path d="M4 5.2v5.6" />
      <path d="M4 5.2c0 2 1.3 3.3 3.3 3.3h3" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Test step: `alchemy test` opens the preview in a new tab of the PR window */
/* ------------------------------------------------------------------ */

const PHOTOS = [
  "linear-gradient(135deg,#6b8f4e,#2f4a22)",
  "linear-gradient(135deg,#d8834f,#7a3c1c)",
  "linear-gradient(135deg,#7ddfff,#2a6f8a)",
  "linear-gradient(135deg,#ffe38a,#b98a2a)",
  "linear-gradient(135deg,#c4729a,#5d2a47)",
];

function SitePage({ t, closing }: { t: number; closing: boolean }) {
  // Test 1 loads the gallery, test 2 uploads, test 3 reloads.
  const reloadAt = T_TESTS[2]![0];
  const reloading = t >= reloadAt && t < reloadAt + 300;
  const loaded = t >= T_PAGE_LOADED && !reloading;
  const [upA, upB] = T_TESTS[1]!;
  const progress = Math.min(1, Math.max(0, (t - upA) / (upB - upA - 40)));
  const shown = loaded
    ? Math.min(4, Math.floor((t - T_PAGE_LOADED) / 40) + 1)
    : 0;
  const active = T_TESTS.findIndex(([a, b]) => t >= a && t < b);
  return (
    <div className={`prf-tabpage ${closing ? "is-closing" : ""}`} aria-hidden>
      <div className="prf-tabwin__url">
        <svg
          viewBox="0 0 16 16"
          width="10"
          height="10"
          aria-hidden
          fill="currentColor"
        >
          <path d="M5 7V5a3 3 0 0 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0Z" />
        </svg>
        {HOST}/photos
        <span className="prf-tabwin__driven">controlled by alchemy test</span>
      </div>
      <div className="prf-site">
        {!loaded ? (
          <div className="prf-site__loading" />
        ) : (
          <>
            <div className="prf-site__nav">
              <span className="prf-site__logo">Photos</span>
              <span className="prf-site__upload">
                {progress > 0 && progress < 1 ? "Uploading…" : "Upload"}
              </span>
            </div>
            <div className="prf-site__grid">
              {progress > 0 && (
                <div
                  className="prf-site__tile prf-enter"
                  style={{
                    background:
                      progress >= 1
                        ? "linear-gradient(135deg,#8fb15e,#3f5a2a)"
                        : undefined,
                  }}
                >
                  {progress < 1 && (
                    <div className="prf-site__progress">
                      <span style={{ transform: `scaleX(${progress})` }} />
                    </div>
                  )}
                  {progress >= 1 && <span className="prf-site__new">new</span>}
                </div>
              )}
              {PHOTOS.slice(0, shown).map((bg, i) => (
                <div
                  key={i}
                  className="prf-site__tile prf-enter"
                  style={{ background: bg }}
                />
              ))}
            </div>
            <div className="prf-site__foot">
              {active >= 0 ? (
                <>
                  <span className="prf-site__pulse" /> {TESTS[active]!.name}
                  <span className="prf-site__slow">
                    {TEST_SLOWDOWN}× slower than real
                  </span>
                </>
              ) : (
                <>
                  <span className="prf-si prf-si--ok prf-site__ok">✓</span> 3
                  tests passed
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
