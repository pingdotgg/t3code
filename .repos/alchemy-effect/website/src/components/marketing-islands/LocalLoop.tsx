import { useEffect, useRef, type ReactNode } from "react";
import { highlightTS } from "../marketing/highlightTS";
import { useSpinner } from "./_terminal";

/*
 * The two steps of the full-picture animation that run on your machine,
 * before the pull request: an agent edits the Worker and the type checker
 * catches the missing Layer, then the same test runs on emulated services
 * and against the real cloud.
 *
 * Left: the editor. Right: the agent's transcript. Like the CI steps,
 * every frame is derived from ms elapsed in the step.
 */

export type LocalStepId = "edit" | "local";

// ---------- Edit: add an upload route, hit the type error, fix it ----------
const T_PROMPT_DONE = 900;
const T_EDIT1 = 1100;
const T_A = [1250, 2050] as const; // typing `const photos = yield* Photos;`
const T_B = [2150, 3250] as const; // typing the upload call
const T_CHECK1 = 3400;
const T_ERROR = 3650;
const T_EDIT2 = 5400;
const T_C = [5550, 6550] as const; // typing `.pipe(Effect.provide([PhotosR2]))`
const T_CHECK2 = 6700;
const T_OK = 6950;
export const EDIT_MS = 8800;

// ---------- Iterate locally: emulated test, then the real cloud ----------
// The live run replays the preview benchmark's measured phases
// (examples/cloudflare-preview-benchmark): deploy 13.35s, destroy 4.76s.
// It plays at LIVE_SPEED× so the step stays short, and says so.
export const LIVE_SPEED = 2;
const T_RUN1 = 300;
const T_EMU_UP = 1500;
const T_EMU_TEST = [1500, 1900] as const;
const T_RUN2 = 2700;
const T_DEPLOY = [2900, 2900 + 13350 / LIVE_SPEED] as const;
const T_LIVE_TEST = [T_DEPLOY[1], T_DEPLOY[1] + 700] as const;
const T_DESTROY = [T_LIVE_TEST[1], T_LIVE_TEST[1] + 4760 / LIVE_SPEED] as const;
const T_LIVE_DONE = T_DESTROY[1] + 150;
const T_PUSH = T_LIVE_DONE + 1100;
export const LOCAL_MS = T_PUSH + 1500;

const GREEN = "var(--alc-accent-bright)";
const RED = "var(--alc-danger)";

const PROMPT = "add photo uploads to the API";
const LINE_A = "    const photos = yield* Photos;";
const LINE_B = "        yield* photos.upload(request.url, yield* request.text);";
const PROVIDE = ".pipe(Effect.provide([PhotosR2]))";
const ERROR = "Type 'Photos' is not assignable to type 'PlatformServices | WorkerServices'.";

const TEST_FILE = [
  "const { test, beforeAll, afterAll, deploy, destroy } = Test.make({",
  "  providers: Cloudflare.providers(),",
  "  dev: !!process.env.LOCAL, // emulated or real cloud",
  "});",
  "",
  "const stack = beforeAll(deploy(Stack));",
  "afterAll(destroy(Stack));",
  "",
  'test("PUT + GET round-trips through R2", Effect.gen(function* () {',
  "  const { url } = yield* stack;",
  "  const res = yield* HttpClient.get(`${url}/object/hello.txt`);",
  '  expect(yield* res.text).toBe("hi!");',
  "}));",
];

const typed = (text: string, [a, b]: readonly [number, number], t: number) =>
  text.slice(0, Math.round(Math.min(1, Math.max(0, (t - a) / (b - a))) * text.length));
const typing = ([a, b]: readonly [number, number], t: number) => t >= a && t < b;
/** Live seconds, scaled back up to real time. */
const liveSecs = (t: number, from: number) =>
  `${((Math.max(0, t - from) * LIVE_SPEED) / 1000).toFixed(1)}s`;

type CodeLine = {
  text: string;
  added?: boolean;
  caret?: boolean;
  error?: boolean;
  lit?: boolean;
};

function Chrome({
  title,
  badge,
  children,
}: {
  title: ReactNode;
  badge?: { text: string; tone: "green" | "red" | "sky" };
  children: ReactNode;
}) {
  return (
    <div className="prf-win">
      <div className="prf-win__bar">
        <span className="prf-dot" style={{ background: "var(--alc-dot-red)" }} />
        <span className="prf-dot" style={{ background: "var(--alc-dot-yellow)" }} />
        <span className="prf-dot" style={{ background: "var(--alc-dot-green)" }} />
        <span className="prf-win__title">{title}</span>
        {badge && <span className={`prf-badge prf-badge--${badge.tone}`}>{badge.text}</span>}
      </div>
      <div className="prf-win__body">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Left: the editor                                                    */
/* ------------------------------------------------------------------ */

function apiLines(t: number): CodeLine[] {
  const error = t >= T_ERROR && t < T_OK;
  const lines: CodeLine[] = [
    { text: "export default Cloudflare.Worker(" },
    { text: '  "Api",' },
    { text: "  { main: import.meta.url }," },
    { text: "  Effect.gen(function* () {", error },
  ];
  if (t >= T_A[0])
    lines.push({
      text: typed(LINE_A, T_A, t),
      added: true,
      caret: typing(T_A, t),
    });
  lines.push(
    { text: "    return {" },
    { text: "      fetch: Effect.gen(function* () {" },
    { text: "        const request = yield* HttpServerRequest;" },
  );
  if (t >= T_B[0])
    lines.push({
      text: typed(LINE_B, T_B, t),
      added: true,
      caret: typing(T_B, t),
    });
  lines.push(
    { text: "        return HttpServerResponse.empty({ status: 201 });" },
    { text: "      })," },
    { text: "    };" },
    {
      text: `  })${typed(PROVIDE, T_C, t)},`,
      added: t >= T_C[0],
      caret: typing(T_C, t),
    },
    { text: ");" },
  );
  return lines;
}

function testLines(t: number): CodeLine[] {
  // The `dev:` line decides where the run goes; the hooks are what the live
  // run adds: a stage of its own, deployed first and destroyed after.
  const emulated = t >= T_RUN1 && t < T_RUN2;
  const live = t >= T_RUN2 && t < T_LIVE_DONE;
  return TEST_FILE.map((text, i) => ({
    text,
    lit: (emulated && i === 2) || (live && (i === 5 || i === 6)),
  }));
}

export function EditorPane({ id, t }: { id: LocalStepId; t: number }) {
  const file = id === "edit" ? "src/api.ts" : "test/api.test.ts";
  const lines = id === "edit" ? apiLines(t) : testLines(t);
  const errorAt = lines.findIndex((l) => l.error);
  return (
    <Chrome title={<>my-app — {file}</>}>
      <div className="prf-edtabs" aria-hidden>
        <span className={`prf-edtab ${id === "edit" ? "is-active" : ""}`}>api.ts</span>
        <span className={`prf-edtab ${id === "local" ? "is-active" : ""}`}>api.test.ts</span>
      </div>
      <div className="prf-code">
        {lines.map((l, i) => (
          <div key={`${file}-${i}`}>
            <div className={`prf-code__line ${l.added ? "is-added" : ""} ${l.lit ? "is-lit" : ""}`}>
              <span className="prf-code__n">{i + 1}</span>
              <span
                className={`prf-code__t ${l.error ? "is-error" : ""}`}
                dangerouslySetInnerHTML={{
                  __html: highlightTS(l.text) || "&nbsp;",
                }}
              />
              {l.caret && <span className="prf-caret" />}
            </div>
            {i === errorAt && (
              <div className="prf-diag prf-enter">
                <span style={{ color: RED }}>✗</span> {ERROR}
              </div>
            )}
          </div>
        ))}
      </div>
    </Chrome>
  );
}

/* ------------------------------------------------------------------ */
/* Right: the agent                                                    */
/* ------------------------------------------------------------------ */

function Action({
  title,
  detail,
  children,
}: {
  title: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="prf-act prf-enter">
      <div className="prf-act__head">
        <span className="prf-act__dot">●</span>
        <span className="prf-strong">{title}</span>
        {detail && <span className="prf-muted"> {detail}</span>}
      </div>
      {children && <div className="prf-act__out">{children}</div>}
    </div>
  );
}

function Row({
  done,
  spin,
  tone = GREEN,
  children,
}: {
  done: boolean;
  spin: string;
  tone?: string;
  children: ReactNode;
}) {
  return (
    <div className="prf-act__row">
      <span className="prf-log__icon" style={{ color: tone }}>
        {done ? "✓" : spin}
      </span>
      {children}
    </div>
  );
}

export function AgentPane({ id, t, paused }: { id: LocalStepId; t: number; paused: boolean }) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });
  const busy =
    id === "edit"
      ? (t >= T_CHECK1 && t < T_ERROR) || (t >= T_CHECK2 && t < T_OK)
      : (t >= T_RUN1 && t < T_EMU_TEST[1]) || (t >= T_RUN2 && t < T_DESTROY[1]);
  const spin = useSpinner(busy && !paused);

  const prompt =
    id === "edit"
      ? PROMPT.slice(0, Math.round(Math.min(1, t / T_PROMPT_DONE) * PROMPT.length))
      : PROMPT;

  const items: ReactNode[] = [
    <div className="prf-act__prompt" key="prompt">
      <span className="prf-muted">›</span> {prompt}
      {id === "edit" && t < T_PROMPT_DONE && <span className="prf-caret" />}
    </div>,
  ];

  if (id === "edit") {
    if (t >= T_EDIT1) items.push(<Action key="e1" title="Edit" detail="src/api.ts · +2 lines" />);
    if (t >= T_CHECK1)
      items.push(
        <Action key="c1" title="Type-check">
          {t < T_ERROR ? (
            <Row done={false} spin={spin}>
              checking
            </Row>
          ) : (
            <>
              <div className="prf-act__row">
                <span className="prf-log__icon" style={{ color: RED }}>
                  ✗
                </span>
                <span style={{ color: RED }}>1 error</span>
                <span className="prf-muted"> · src/api.ts:4</span>
              </div>
              <div className="prf-act__msg">{ERROR}</div>
            </>
          )}
        </Action>,
      );
    if (t >= T_EDIT2)
      items.push(<Action key="e2" title="Edit" detail="src/api.ts · provide PhotosR2" />);
    if (t >= T_CHECK2)
      items.push(
        <Action key="c2" title="Type-check">
          <Row done={t >= T_OK} spin={spin}>
            {t >= T_OK ? "no errors" : "checking"}
          </Row>
        </Action>,
      );
  } else {
    items.push(<Action key="done-edit" title="Edit" detail="src/api.ts · type-checks" />);
    if (t >= T_RUN1)
      items.push(
        <Action key="r1" title="Run" detail="LOCAL=1 pnpm test">
          <Row done={t >= T_EMU_UP} spin={spin}>
            {t >= T_EMU_UP ? "stack running on emulated services" : "starting emulated services"}
          </Row>
          {t >= T_EMU_TEST[0] && (
            <Row done={t >= T_EMU_TEST[1]} spin={spin}>
              PUT + GET round-trips through R2
            </Row>
          )}
          {t >= T_EMU_TEST[1] && (
            <div className="prf-act__row">
              <span style={{ color: GREEN }}>1 pass</span>
              <span className="prf-muted"> · 0 fail · nothing deployed</span>
            </div>
          )}
        </Action>,
      );
    if (t >= T_RUN2)
      items.push(
        <Action key="r2" title="Run" detail="pnpm test">
          {t >= T_DEPLOY[0] && (
            <Row done={t >= T_DEPLOY[1]} spin={spin}>
              {t >= T_DEPLOY[1] ? "deployed" : "deploying"} 3 resources
              <span className="prf-muted">
                {" · "}
                {liveSecs(Math.min(t, T_DEPLOY[1]), T_DEPLOY[0])}
              </span>
            </Row>
          )}
          {t >= T_LIVE_TEST[0] && (
            <Row done={t >= T_LIVE_TEST[1]} spin={spin}>
              PUT + GET round-trips through R2
            </Row>
          )}
          {t >= T_DESTROY[0] && (
            <Row done={t >= T_DESTROY[1]} spin={spin} tone={RED}>
              {t >= T_DESTROY[1] ? "destroyed" : "destroying"} 3 resources
              <span className="prf-muted">
                {" · "}
                {liveSecs(Math.min(t, T_DESTROY[1]), T_DESTROY[0])}
              </span>
            </Row>
          )}
          {t < T_LIVE_DONE ? (
            <div className="prf-act__row prf-muted">
              {"  "}(played at {LIVE_SPEED}× speed)
            </div>
          ) : (
            <div className="prf-act__row">
              <span style={{ color: GREEN }}>1 pass</span>
              <span className="prf-muted"> · 0 fail · real cloud</span>
            </div>
          )}
        </Action>,
      );
    if (t >= T_PUSH)
      items.push(
        <Action key="push" title="Push" detail="feature/photo-upload · open a pull request" />,
      );
  }

  return (
    <Chrome
      title="agent · my-app"
      badge={id === "edit" ? { text: "TYPE-CHECK", tone: "sky" } : { text: "TEST", tone: "green" }}
    >
      <div className="prf-agent" ref={listRef}>
        {items}
      </div>
    </Chrome>
  );
}
