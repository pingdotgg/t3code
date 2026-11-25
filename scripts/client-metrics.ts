#!/usr/bin/env node
// Measures thread switching, right-panel cost and client memory/CPU in the real web app: a
// production build served by a seeded server, driven by headless Chromium like a person. See
// docs/internals/16_performance-regressions.md.
// @effect-diagnostics nodeBuiltinImport:off - NodeHttpServer takes a node:http server, and SourceMap has no Effect counterpart.
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/cli";
import { HttpClient, HttpClientResponse, HttpServer, HttpServerResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";

import {
  analyzeClickTasks,
  CASES,
  ClientMetrics,
  compareClientMetrics,
  parseCases,
  summaryTable,
  Trace,
  type Case,
  type CallSite,
  type Forced,
  type Idle,
  type Memory,
  type Run,
  type Switch,
} from "./client-metrics-report.ts";
import { prepareHome, SCENARIO_MACHINE_ENV } from "./scenarios/start-app.ts";
import { run } from "./scenarios/shell.ts";
import { serveFakeGitHub, type FakePullRequestDetail } from "./server-metrics-forge.ts";
import { describeFailure, loadWarnings } from "./server-metrics-report.ts";
import {
  descendantsOf,
  freePort,
  machineLoad,
  MetricsError,
  nowMs,
  output,
  runAbRounds,
  watchMachine,
} from "./server-metrics.ts";

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
const encodeMetrics = Schema.encodeEffect(fromJsonStringPretty(ClientMetrics));
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeObject = Schema.decodeUnknownEffect(JsonObject);
const decodeSettings = decodeJson(JsonObject);
const decodeLaunched = decodeJson(Schema.Struct({ threadId: Schema.String }));
const decodeTrace = decodeJson(Trace);
const decodeMetrics = decodeJson(ClientMetrics);

/** The harness's own replay agent, so an older checkout still plays the bench recordings. */
const REPLAY_AGENT = new URL("../apps/server/scripts/dev-replay-agent.ts", import.meta.url);
const VIEWPORT = { width: 1512, height: 900 };
/** How long a switch is watched: probes read the frames and long frames in this window. */
const SETTLE_MS = 1_600;
const IDLE_SECONDS = 10;

const browserPromise = <A>(what: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new MetricsError({ message: `${what}: ${describeFailure(cause)}` }),
  });

/** Many files with many lines, so the Diff panel and the PR's files have real weight. */
const DIFF_FILES = 40;
const DIFF_LINES = 60;
const sourceFile = (index: number, variant: "before" | "after") =>
  Array.from({ length: DIFF_LINES }, (_, line) =>
    line % 10 === 0
      ? `export function helper${index}_${line}(input: ReadonlyArray<number>) {`
      : line % 10 === 9
        ? "}"
        : variant === "after" && line % 3 === 0
          ? `  const value${line} = input.map((entry) => entry ** ${line}).filter(Boolean); // changed`
          : `  const value${line} = input.map((entry) => entry * ${line}).filter(Boolean);`,
  ).join("\n") + "\n";

const pullRequestDetail = (): FakePullRequestDetail => {
  const files = Array.from({ length: DIFF_FILES }, (_, index) => {
    const changed = Array.from({ length: DIFF_LINES }, (_, line) => line).filter(
      (line) => line % 10 !== 0 && line % 10 !== 9 && line % 3 === 0,
    );
    const patch = [
      `@@ -1,${DIFF_LINES} +1,${DIFF_LINES} @@`,
      ...changed.flatMap((line) => [
        `-  const value${line} = input.map((entry) => entry * ${line}).filter(Boolean);`,
        `+  const value${line} = input.map((entry) => entry ** ${line}).filter(Boolean); // changed`,
      ]),
    ].join("\n");
    return {
      path: `src/module${index}.ts`,
      additions: changed.length,
      deletions: changed.length,
      patch,
    };
  });
  const section = (title: string) =>
    `## ${title}\n\nThis part of the change moves the helpers behind one entry point. Callers keep their signatures; each module now **squares** its inputs before filtering, and the filters skip falsy values.\n\n- \`src/module0.ts\` through \`src/module9.ts\` read the new helpers\n- the tests cover the empty input and the largest one\n- nothing outside \`src/\` moves\n\n\`\`\`ts\nexport function helper0_0(input: ReadonlyArray<number>) {\n  return input.map((entry) => entry ** 2).filter(Boolean);\n}\n\`\`\`\n`;
  return {
    body: [
      "Squares every helper's input and moves them behind one entry point.",
      ...["Why", "What changed", "How it was tested", "Follow-ups", "Risks"].map(section),
      "| module | before | after |\n| :-- | --: | --: |\n" +
        Array.from(
          { length: 12 },
          (_, index) => `| module${index} | ${index * 3} ms | ${index * 2} ms |`,
        ).join("\n"),
    ].join("\n\n"),
    files,
    comments: Array.from(
      { length: 12 },
      (_, index) =>
        `Comment ${index + 1}: the helper in \`src/module${index}.ts\` reads better now. Could the filter keep zero?\n\n> ${"Quoted context from the review. ".repeat(3)}`,
    ),
    commits: 8,
  };
};

const FIXTURE_PAGE = `<!doctype html>
<title>Bench fixture</title>
<body style="font: 16px/1.5 system-ui; margin: 2rem auto; max-width: 48rem">
<h1>Bench fixture page</h1>
${Array.from({ length: 30 }, (_, index) => `<h2>Section ${index + 1}</h2><p>${"A static page the server browser streams, with enough text to fill its viewport. ".repeat(6)}</p>`).join("\n")}
</body>`;

/** Serves the Browser case's page on loopback until the scope closes. */
const serveFixturePage = Effect.gen(function* () {
  const context = yield* Layer.build(
    NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" }),
  );
  return yield* Effect.gen(function* () {
    yield* HttpServer.serveEffect(
      Effect.succeed(HttpServerResponse.text(FIXTURE_PAGE, { contentType: "text/html" })),
    );
    const { address } = yield* HttpServer.HttpServer;
    return `http://127.0.0.1:${address._tag === "UnixPathAddress" ? 0 : address.port}/`;
  }).pipe(Effect.provide(context));
});

/** Builds a checkout's web app for production, sourcemaps on. */
const buildWeb = Effect.fn("clientMetrics.buildWeb")(function* (checkout: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const environment = yield* HostProcess.Environment;
  const web = path.join(checkout, "apps/web");
  yield* Console.error(`building ${web} for production...`);
  const env = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !["T3CODE_WEB_SOURCEMAP", "VITE_HTTP_URL", "VITE_WS_URL"].includes(entry[0]),
    ),
  );
  yield* run("vp", ["build"], { cwd: web, env });
  if (!(yield* fs.exists(path.join(web, "dist/index.html")))) {
    return yield* new MetricsError({ message: `${web}/dist has no index.html after the build` });
  }
});

interface Seeded {
  readonly origin: string;
  readonly environmentId: string;
  readonly pairingUrl: string;
  readonly threads: Readonly<Record<Case | "hub", string>>;
  readonly fixtureUrl: string;
}

/**
 * A server on a fresh base dir under `root`, serving the checkout's built web app, with one git
 * project on a branch that has a large diff and an open PR on a fake GitHub. Stopped, with every
 * process below it, when the scope closes.
 */
const startSeededApp = Effect.fn("clientMetrics.startSeededApp")(function* (
  checkout: string,
  root: string,
  longTurns: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = yield* HttpClient.HttpClient;
  const node = yield* HostProcess.ExecutablePath;
  const hostEnvironment = yield* HostProcess.Environment;
  const serverDir = path.join(checkout, "apps/server");
  const home = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: "run-" });
  const baseDir = path.join(home, "base");
  yield* prepareHome(baseDir);
  // Every run shares one headless-shell install, so only the first run downloads it.
  yield* fs.makeDirectory(path.join(root, "tools"), { recursive: true });
  yield* fs.symlink(path.join(root, "tools"), path.join(baseDir, "tools"));
  const settingsFile = path.join(baseDir, "userdata/settings.json");
  const settings = yield* fs.readFileString(settingsFile).pipe(Effect.flatMap(decodeSettings));
  const providerInstances = yield* decodeObject(settings.providerInstances);
  yield* fs.writeFileString(
    settingsFile,
    encodeJson({
      ...settings,
      providerInstances: {
        ...providerInstances,
        devReplay: {
          displayName: "Replay (dev)",
          driver: "acpRegistry",
          config: {
            source: "local",
            commandPath: node,
            commandArgs: [yield* path.fromFileUrl(REPLAY_AGENT)],
          },
        },
      },
    }),
  );

  const forge = yield* serveFakeGitHub({ detail: pullRequestDetail() });
  const project = path.join(home, "project");
  const git = (args: ReadonlyArray<string>) => run("git", args, { cwd: project });
  const author = ["-c", "user.email=bench@t3.codes", "-c", "user.name=bench"];
  yield* fs.makeDirectory(path.join(project, "src"), { recursive: true });
  yield* fs.writeFileString(path.join(project, "README.md"), "# bench\n");
  for (let index = 0; index < DIFF_FILES; index++) {
    yield* fs.writeFileString(
      path.join(project, `src/module${index}.ts`),
      sourceFile(index, "before"),
    );
  }
  yield* git(["-c", "init.defaultRefFormat=files", "init", "-q", "-b", "main"]);
  yield* git(["add", "."]);
  yield* git([...author, "commit", "-qm", "init"]);
  // The feature branch commits these, so its diff against main is the Diff case's weight.
  for (let index = 0; index < DIFF_FILES; index++) {
    yield* fs.writeFileString(
      path.join(project, `src/module${index}.ts`),
      sourceFile(index, "after"),
    );
  }
  yield* forge.setupProject(project);

  const dropped = new Set(["T3CODE_HOME", "XDG_CONFIG_HOME", "VITE_HTTP_URL", "VITE_WS_URL"]);
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(hostEnvironment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && !dropped.has(entry[0]),
      ),
    ),
    HOME: home,
    USERPROFILE: home,
    PATH: [path.join(baseDir, "bin"), hostEnvironment.PATH ?? ""].join(":"),
    OTEL_SDK_DISABLED: "true",
    T3CODE_DEV_SEED: "0",
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
    ...SCENARIO_MACHINE_ENV,
    ...forge.env,
    // The fake GitHub's proxy only tunnels its host; the Browser case's headless shell downloads direct.
    NO_PROXY: `${forge.env.NO_PROXY},storage.googleapis.com`,
    no_proxy: `${forge.env.no_proxy},storage.googleapis.com`,
  };
  const port = yield* freePort;
  const child = yield* spawner.spawn(
    ChildProcess.make(
      node,
      ["src/bin.ts", "serve", "--base-dir", baseDir, "--port", `${port}`, "--host", "127.0.0.1"],
      {
        cwd: serverDir,
        env,
        extendEnv: false,
        forceKillAfter: Duration.seconds(10),
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      },
    ),
  );
  const pid = Number(child.pid);
  const stderr = yield* Ref.make("");
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => Ref.update(stderr, (text) => (text + chunk).slice(-8_000))),
    Effect.ignore,
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      // Replay agents and the server's headless shell run below the server.
      const spawned = yield* descendantsOf(pid).pipe(Effect.orElseSucceed(() => []));
      yield* child
        .kill({ killSignal: "SIGTERM", forceKillAfter: Duration.seconds(10) })
        .pipe(Effect.timeout(Duration.seconds(15)), Effect.ignore);
      yield* child.exitCode.pipe(Effect.timeout(Duration.seconds(10)), Effect.ignore);
      if (spawned.length > 0) yield* output("kill", ["-9", ...spawned.map(String)]);
    }).pipe(Effect.ignore),
  );
  const origin = `http://127.0.0.1:${port}`;
  yield* http.get(`${origin}/`).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.timeout(Duration.seconds(1)),
    Effect.retry({ schedule: Schedule.spaced(Duration.millis(200)), times: 600 }),
    Effect.catch(() =>
      Effect.flatMap(
        Ref.get(stderr),
        (text) => new MetricsError({ message: `server never served the web app:\n${text}` }),
      ),
    ),
  );
  yield* fs.exists(path.join(baseDir, "userdata/server-runtime.json")).pipe(
    Effect.filterOrFail((recorded) => recorded),
    Effect.retry({ schedule: Schedule.spaced(Duration.millis(100)), times: 3_000 }),
    Effect.mapError(() => new MetricsError({ message: "server never recorded its runtime state" })),
  );

  const cli = (args: ReadonlyArray<string>, allowExit: ReadonlyArray<number> = [0]) =>
    run(node, ["src/bin.ts", ...args, "--base-dir", baseDir], {
      cwd: serverDir,
      env,
      allowExit,
    }).pipe(Effect.mapError((error) => new MetricsError({ message: error.message })));
  yield* cli(["project", "add", project]);
  const thread = Effect.fn("clientMetrics.seedThread")(function* (
    title: string,
    model: string,
    turns: number,
  ) {
    // Exit 2: the turn waits on an approval, which the approval case wants.
    const started = yield* cli(
      [
        "thread",
        "start",
        project,
        "Start",
        "--title",
        title,
        "--provider",
        "devReplay",
        "--model",
        model,
        "--wait",
        "--json",
      ],
      [0, 2],
    );
    const { threadId } = yield* decodeLaunched(started.stdout).pipe(
      Effect.mapError(
        () => new MetricsError({ message: `thread start printed no id: ${started.stdout}` }),
      ),
    );
    for (let turn = 1; turn < turns; turn++) {
      yield* cli(["thread", "send", threadId, `Turn ${turn + 1}`, "--wait", "--json"], [0, 2]);
    }
    return threadId;
  });
  yield* Console.error("seeding threads through the CLI...");
  const plan: ReadonlyArray<readonly [Case | "hub", string, number]> = [
    ["hub", "multi-turn", 1],
    ["short", "multi-turn", 1],
    ["long", "bench-heavy", longTurns],
    ["approval", "approval", 1],
    ["medium", "bench-heavy", 3],
    ["diff", "bench-heavy", 3],
    ["pull-request", "bench-heavy", 3],
    ["browser", "bench-heavy", 3],
    ["device", "bench-heavy", 3],
  ];
  const ids = yield* Effect.forEach(
    plan,
    ([name, model, turns]) =>
      Effect.map(thread(`Bench ${name}`, model, turns), (id) => [name, id] as const),
    { concurrency: 4 },
  );
  // Its one turn streams for many minutes, so it is still working while every case is measured.
  const working = yield* cli([
    "thread",
    "start",
    project,
    "Start",
    "--title",
    "Bench working",
    "--provider",
    "devReplay",
    "--model",
    "bench-stream",
    "--json",
  ]).pipe(Effect.flatMap(({ stdout }) => decodeLaunched(stdout)));
  const threads = Object.fromEntries([...ids, ["working", working.threadId]]) as Record<
    Case | "hub",
    string
  >;
  const pair = yield* cli(["pair", "--label", "client-metrics"]);
  const pairingUrl = /https?:\/\/\S+\/pair#token=\S+/.exec(pair.stdout)?.[0];
  if (!pairingUrl) {
    return yield* new MetricsError({ message: `pair printed no pairing URL:\n${pair.stdout}` });
  }
  const environmentId = yield* http.get(`${origin}/.well-known/t3/environment`).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(
      HttpClientResponse.schemaBodyJson(Schema.Struct({ environmentId: Schema.String })),
    ),
    Effect.map(({ environmentId }) => environmentId),
    Effect.mapError((error) => new MetricsError({ message: `environment id: ${error}` })),
  );
  const seeded: Seeded = {
    origin,
    environmentId,
    pairingUrl,
    threads,
    fixtureUrl: yield* serveFixturePage,
  };
  return seeded;
});

/** In-page probes: Event Timing, long animation frames, and a rAF watch on each switch. */
const INSTALL_PROBES = `(() => {
  const bench = { events: [], loaf: [], last: null };
  window.__clientMetrics = bench;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name === "click") bench.events.push({ start: entry.startTime, duration: entry.duration });
    }
  }).observe({ type: "event", durationThreshold: 16, buffered: false });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) bench.loaf.push({ start: entry.startTime, duration: entry.duration });
  }).observe({ type: "long-animation-frame", buffered: false });
  bench.watch = (fromPath) => {
    const t0 = performance.now();
    const watch = { t0, frames: [] };
    const tick = (ts) => {
      watch.frames.push({
        ts,
        moved: location.pathname !== fromPath,
        rows: document.querySelectorAll("[data-timeline-row-id]").length,
        loading: document.querySelector("[data-timeline-loading]") !== null,
      });
      if (ts - t0 < ${SETTLE_MS + 900}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    bench.last = watch;
  };
})()`;

const READ_SWITCH = `(() => {
  const bench = window.__clientMetrics;
  const watch = bench.last;
  const event = bench.events.find((entry) => entry.start >= watch.t0 - 5);
  const moved = watch.frames.find((frame) => frame.moved);
  const content = watch.frames.find((frame) => frame.moved && frame.rows > 0 && !frame.loading);
  const loaf = bench.loaf
    .filter((entry) => entry.start >= watch.t0 - 5 && entry.start < watch.t0 + 1500)
    .reduce((sum, entry) => sum + entry.duration, 0);
  return {
    paintMs: event ? Math.round(event.duration) : null,
    contentMs: content ? Math.round(content.ts - watch.t0) : null,
    firstFrameContent: Boolean(moved && content && moved === content),
    loafMs: Math.round(loaf),
  };
})()`;
const SwitchReading = Schema.Struct({
  paintMs: Schema.NullOr(Schema.Number),
  contentMs: Schema.NullOr(Schema.Number),
  firstFrameContent: Schema.Boolean,
  loafMs: Schema.Number,
});

const evaluate = <S extends Schema.Top>(page: Page, script: string, schema: S) =>
  browserPromise("page script", () => page.evaluate(script)).pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(schema)(value)),
    Effect.mapError((error) =>
      error._tag === "MetricsError" ? error : new MetricsError({ message: `${error}` }),
    ),
  );

const memoryAfterGc = Effect.fn("clientMetrics.memory")(function* (
  page: Page,
  cdp: CDPSession,
  label: string,
) {
  yield* browserPromise("collect garbage", async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    await cdp.send("HeapProfiler.collectGarbage");
  });
  const heap = yield* evaluate(page, "performance.memory.usedJSHeapSize", Schema.Number);
  const counters = yield* browserPromise("DOM counters", () => cdp.send("Memory.getDOMCounters"));
  const memory: Memory = {
    label,
    heapMB: Math.round(heap / 1e5) / 10,
    domNodes: counters.nodes,
    listeners: counters.jsEventListeners,
  };
  return memory;
});

const idleCpu = Effect.fn("clientMetrics.idleCpu")(function* (cdp: CDPSession, label: string) {
  const read = browserPromise("performance metrics", () => cdp.send("Performance.getMetrics")).pipe(
    Effect.map(({ metrics }) => new Map(metrics.map(({ name, value }) => [name, value]))),
  );
  const startedAt = yield* nowMs;
  const before = yield* read;
  yield* Effect.sleep(Duration.seconds(IDLE_SECONDS));
  const after = yield* read;
  const seconds = ((yield* nowMs) - startedAt) / 1_000;
  const pct = (name: string) =>
    Math.round((((after.get(name) ?? 0) - (before.get(name) ?? 0)) / seconds) * 1_000) / 10;
  const idle: Idle = {
    label,
    seconds: Math.round(seconds * 10) / 10,
    taskPct: pct("TaskDuration"),
    scriptPct: pct("ScriptDuration"),
    stylePct: pct("RecalcStyleDuration"),
    layoutPct: pct("LayoutDuration"),
  };
  return idle;
});

/** Opens `threadId` the way a person does: pointer onto its sidebar row, rest, press, release. */
const clickRow = Effect.fn("clientMetrics.clickRow")(function* (
  page: Page,
  rowKey: string,
  measure: boolean,
) {
  const row = page.locator(`[data-sidebar-row="${rowKey}"]`).first();
  yield* browserPromise(`sidebar row ${rowKey}`, () =>
    row.scrollIntoViewIfNeeded({ timeout: 10_000 }),
  );
  const box = yield* browserPromise("row box", () => row.boundingBox());
  if (box === null) return yield* new MetricsError({ message: `sidebar row ${rowKey} is hidden` });
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 14);
  yield* browserPromise("pointer", async () => {
    await page.mouse.move(x - 40, y);
    await page.mouse.move(x, y, { steps: 4 });
  });
  yield* Effect.sleep(Duration.millis(350));
  if (measure) {
    yield* browserPromise("watch", () =>
      page.evaluate(`window.__clientMetrics.watch(location.pathname)`),
    );
  }
  yield* browserPromise("press", async () => {
    await page.mouse.down();
    await page.waitForTimeout(80);
    await page.mouse.up();
  });
  yield* Effect.sleep(Duration.millis(SETTLE_MS));
  if (!measure) return undefined;
  return yield* evaluate(page, READ_SWITCH, SwitchReading);
});

/** Opens each panel case's surface through the right panel launcher, as a person would. */
const openPanels = Effect.fn("clientMetrics.openPanels")(function* (
  page: Page,
  seeded: Seeded,
  cases: ReadonlyArray<Case>,
  shotsDir: string | undefined,
) {
  const path = yield* Path.Path;
  const launchers: Partial<Record<Case, string>> = {
    diff: "Diff",
    "pull-request": "Pull request",
    browser: "Browser",
    device: "Device",
  };
  for (const name of cases) {
    const label = launchers[name];
    if (label === undefined) continue;
    yield* browserPromise(`open the ${name} panel`, async () => {
      await page.goto(`${seeded.origin}/${seeded.environmentId}/${seeded.threads[name]}`);
      await page.waitForSelector("[data-timeline-row-id]", { timeout: 60_000 });
      await page
        .getByRole("button", { name: /^Toggle right panel/ })
        .first()
        .click();
      const launcher = page.locator('[aria-label="Open a surface"] button', {
        hasText: new RegExp(`^${label}`),
      });
      await launcher.first().click({ timeout: 30_000 });
      if (name === "browser") {
        const address = page.getByRole("textbox", { name: "Search or enter URL" });
        // Disabled until the server's headless shell is installed; the first run downloads it.
        await address.fill(seeded.fixtureUrl, { timeout: 300_000 });
        await address.press("Enter");
        await page.getByText("Bench fixture").first().waitFor({ timeout: 240_000 });
      }
      await page.waitForTimeout(3_000);
      if (shotsDir !== undefined) {
        await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
      }
    });
  }
});

const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.stack",
  "v8.execute",
  "blink.user_timing",
  "loading",
  "latencyInfo",
];

const SourceMapJson = Schema.Struct({
  version: Schema.Number,
  file: Schema.optional(Schema.String),
  sourceRoot: Schema.optional(Schema.String),
  sources: Schema.Array(Schema.String),
  sourcesContent: Schema.optional(Schema.Array(Schema.NullOr(Schema.String))),
  names: Schema.Array(Schema.String),
  mappings: Schema.String,
});

const decodeSourceMap = decodeJson(SourceMapJson);

/** Maps stack frames through the build's sourcemaps; frames outside them stay as they are. */
const loadSourceMaps = Effect.fn("clientMetrics.loadSourceMaps")(function* (
  checkout: string,
  assets: string,
  urls: ReadonlySet<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const maps = new Map<string, NodeModule.SourceMap>();
  for (const url of urls) {
    const file = url.split("/").pop()?.split("?")[0] ?? "";
    if (!file.endsWith(".js") || maps.has(file)) continue;
    const parsed = yield* fs
      .readFileString(path.join(assets, `${file}.map`))
      .pipe(Effect.flatMap(decodeSourceMap), Effect.option);
    if (Option.isNone(parsed)) continue;
    const payload: NodeModule.SourceMapPayload = {
      file: parsed.value.file ?? file,
      version: parsed.value.version,
      sourceRoot: parsed.value.sourceRoot ?? "",
      sources: [...parsed.value.sources],
      sourcesContent: [],
      names: [...parsed.value.names],
      mappings: parsed.value.mappings,
    };
    maps.set(file, new NodeModule.SourceMap(payload));
  }
  return (url: string, line: number, column: number) => {
    const map = maps.get(url.split("/").pop()?.split("?")[0] ?? "");
    const entry = map?.findEntry(line, column);
    if (entry === undefined || !("originalSource" in entry)) return undefined;
    const source = entry.originalSource.includes("node_modules/")
      ? `nm:${entry.originalSource.split("node_modules/").pop()}`
      : // Sources sit relative to the map in apps/web/dist/assets.
        path.relative(checkout, path.resolve(assets, entry.originalSource));
    return `${source}:${entry.originalLine + 1}`;
  };
});

interface MeasureOptions {
  readonly checkout: string;
  readonly root: string;
  readonly cases: ReadonlyArray<Case>;
  readonly switchRounds: number;
  readonly longTurns: number;
  readonly trace: boolean;
  /** Where screenshots and the trace go; none keeps nothing. */
  readonly artifacts: string | undefined;
}

/** One measured run on a fresh server and browser. */
const measureOnce = Effect.fn("clientMetrics.measureOnce")(function* (options: MeasureOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const machine = yield* watchMachine;
  const seeded = yield* startSeededApp(options.checkout, options.root, options.longTurns);
  const rowKey = (name: Case | "hub") => `${seeded.environmentId}:${seeded.threads[name]}`;
  if (options.artifacts !== undefined) {
    yield* fs.makeDirectory(options.artifacts, { recursive: true });
  }
  const browser = yield* Effect.acquireRelease(
    browserPromise("launch Chromium", () =>
      chromium.launch({
        headless: true,
        args: ["--enable-gpu-rasterization", "--enable-precise-memory-info"],
      }),
    ),
    (launched: Browser) => Effect.promise(() => launched.close()).pipe(Effect.ignore),
  );
  const context = yield* browserPromise("browser context", () =>
    browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 }),
  );
  const page = yield* browserPromise("page", () => context.newPage());
  yield* browserPromise("pair", async () => {
    await page.goto(seeded.pairingUrl);
    await page.waitForSelector("[data-sidebar-row]", { timeout: 90_000 });
  });
  yield* openPanels(page, seeded, options.cases, options.artifacts);

  // A fresh document, so round 0 visits every thread for the first time in this page.
  yield* browserPromise("reload on the hub thread", async () => {
    await page.goto(`${seeded.origin}/${seeded.environmentId}/${seeded.threads.hub}`);
    await page.waitForSelector("[data-timeline-row-id]", { timeout: 60_000 });
    await page.waitForTimeout(3_000);
    await page.evaluate(INSTALL_PROBES);
  });
  const listRows = evaluate(
    page,
    `[...document.querySelectorAll("[data-sidebar-row]")].map((row) => row.getAttribute("data-sidebar-row"))`,
    Schema.Array(Schema.String),
  );
  const missingFrom = (rows: ReadonlyArray<string>) =>
    options.cases.filter((name) => !rows.includes(rowKey(name)));
  // Working and older settled threads sit in shelves; each is opened only if a case hides there.
  for (const shelf of ["shelf:working", "shelf:settled"]) {
    const rows = yield* listRows;
    if (missingFrom(rows).length === 0 || !rows.includes(shelf)) continue;
    yield* browserPromise(`open ${shelf}`, async () => {
      await page.locator(`[data-sidebar-row="${shelf}"]`).first().click();
      await page.waitForTimeout(1_000);
    });
  }
  const listed = yield* listRows;
  const missing = missingFrom(listed);
  if (missing.length > 0) {
    return yield* new MetricsError({
      message: `the sidebar lists no row for ${missing.join(", ")}; it lists ${listed.join(", ")}`,
    });
  }
  if (options.artifacts !== undefined) {
    const shot = path.join(options.artifacts, "loaded.png");
    yield* browserPromise("screenshot", () => page.screenshot({ path: shot }));
  }
  const cdp = yield* browserPromise("CDP session", () => context.newCDPSession(page));
  yield* browserPromise("CDP domains", () => cdp.send("Performance.enable"));
  const memory: Memory[] = [yield* memoryAfterGc(page, cdp, "loaded")];
  const switches: Switch[] = [];
  const onHub = Effect.gen(function* () {
    const current = yield* evaluate(page, "location.pathname", Schema.String);
    if (!current.endsWith(`/${seeded.threads.hub}`)) yield* clickRow(page, rowKey("hub"), false);
  });
  for (let round = 0; round < options.switchRounds; round++) {
    for (const name of options.cases) {
      yield* onHub;
      const reading = yield* clickRow(page, rowKey(name), true);
      if (reading === undefined) continue;
      switches.push({ case: name, visit: round === 0 ? "first" : "revisit", round, ...reading });
      yield* Console.error(
        `round ${round + 1}/${options.switchRounds} ${name}: paint ${reading.paintMs ?? "<16"} ms, LoAF ${reading.loafMs} ms${reading.firstFrameContent ? "" : ", content after the first frame"}`,
      );
    }
    if (round === 0) memory.push(yield* memoryAfterGc(page, cdp, "after first visits"));
  }
  memory.push(yield* memoryAfterGc(page, cdp, `after ${switches.length} measured switches`));

  let forced: ReadonlyArray<Forced> | undefined;
  let callSites: ReadonlyArray<CallSite> | undefined;
  if (options.trace) {
    yield* Console.error("tracing one more round...");
    const labels: string[] = [];
    yield* onHub;
    yield* browserPromise("start tracing", () =>
      browser.startTracing(page, { screenshots: false, categories: TRACE_CATEGORIES }),
    );
    for (const name of options.cases) {
      const current = yield* evaluate(page, "location.pathname", Schema.String);
      if (!current.endsWith(`/${seeded.threads.hub}`)) {
        yield* clickRow(page, rowKey("hub"), false);
        labels.push("hub");
      }
      yield* clickRow(page, rowKey(name), false);
      labels.push(name);
    }
    const buffer = yield* browserPromise("stop tracing", () => browser.stopTracing());
    const text = new TextDecoder().decode(buffer);
    if (options.artifacts !== undefined) {
      yield* fs.writeFileString(path.join(options.artifacts, "trace.json"), text);
    }
    const trace = yield* decodeTrace(text).pipe(
      Effect.mapError((error) => new MetricsError({ message: `trace: ${error}` })),
    );
    const events = "traceEvents" in trace ? trace.traceEvents : trace;
    const urls = new Set(
      events.flatMap((event) =>
        (event.args?.beginData?.stackTrace ?? []).map((frame) => frame.url),
      ),
    );
    const mapper = yield* loadSourceMaps(
      options.checkout,
      path.join(options.checkout, "apps/web/dist/assets"),
      urls,
    );
    const analyzed = analyzeClickTasks(events, labels, mapper);
    if (analyzed === undefined) {
      yield* Console.error(
        `the trace's clicks did not match the ${labels.length} made; no forced table`,
      );
    } else {
      forced = analyzed.perClick.filter((entry) => entry.case !== "hub");
      callSites = analyzed.callSites;
    }
  }

  const idle: Idle[] = [];
  if (options.cases.includes("working")) {
    yield* clickRow(page, rowKey("working"), false);
    idle.push(yield* idleCpu(cdp, "on the working thread"));
    yield* clickRow(page, rowKey("hub"), false);
    idle.push(yield* idleCpu(cdp, "on an idle thread"));
  }
  const result: Run = {
    switches,
    memory,
    idle,
    ...(forced === undefined ? {} : { forced }),
    machine: yield* machine,
  };
  return { run: result, callSites, chromium: browser.version() };
}, Effect.scoped);

const metaFor = Effect.fn("clientMetrics.metaFor")(function* (checkout: string) {
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const node = yield* HostProcess.ExecutablePath;
  const cpus = yield* output("getconf", ["_NPROCESSORS_ONLN"]);
  return {
    platform: `${platform}-${architecture}`,
    cpus: Option.getOrNull(Option.map(cpus, Number)),
    node: Option.getOrNull(yield* output(node, ["--version"])),
    commit: Option.getOrNull(yield* output("git", ["rev-parse", "--short=12", "HEAD"], checkout)),
    loadBefore: yield* machineLoad,
    measuredAt: DateTime.formatIso(yield* DateTime.now),
  };
});

const writeMetrics = Effect.fn("clientMetrics.writeMetrics")(function* (
  out: Option.Option<string>,
  metrics: ClientMetrics,
) {
  const fs = yield* FileSystem.FileSystem;
  const json = yield* encodeMetrics(metrics);
  if (Option.isSome(out)) {
    const temp = `${out.value}.tmp`;
    yield* fs.writeFileString(temp, `${json}\n`);
    yield* fs.rename(temp, out.value);
  }
});

/** Prints the comparison and sets exit code 1 when a metric got worse. */
const report = Effect.fn("clientMetrics.report")(function* (
  before: ClientMetrics,
  after: ClientMetrics,
  threshold: number,
) {
  const { table, regressed, improved, compared } = compareClientMetrics(before, after, threshold);
  yield* Console.log(table);
  for (const warning of [...loadWarnings("before", before), ...loadWarnings("after", after)]) {
    yield* Console.error(`Warning: ${warning}`);
  }
  if (compared === 0) {
    return yield* new MetricsError({ message: "the two files share no metric" });
  }
  if (improved.length) yield* Console.error(`Better: ${improved.join(", ")}`);
  if (regressed.length === 0) return;
  yield* Console.error(`Worse: ${regressed.join(", ")}`);
  yield* Effect.sync(() => {
    process.exitCode = 1;
  });
});

/** The persistent directory runs live in: under home, since /tmp can be small. */
const workRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const home = environment.HOME ?? environment.USERPROFILE;
  if (home === undefined) return yield* new MetricsError({ message: "HOME is not set" });
  const root = path.join(home, ".cache", "t3-client-metrics");
  yield* fs.makeDirectory(root, { recursive: true });
  return root;
});

const measureFlags = {
  switchRounds: Flag.Int("switch-rounds").pipe(
    Flag.withSchema(PositiveInt),
    Flag.withDescription(
      "Visits to every case per run: the first is a first visit, the rest revisits.",
    ),
    Flag.withDefault(4),
  ),
  longTurns: Flag.Int("long-turns").pipe(
    Flag.withSchema(PositiveInt),
    Flag.withDescription("Turns in the long thread, each a heavy recorded turn."),
    Flag.withDefault(12),
  ),
  cases: Flag.String("cases").pipe(
    Flag.withDescription(`Cases to switch to, comma separated: ${CASES.join(", ")}.`),
    Flag.withDefault(""),
  ),
  trace: Flag.Boolean("trace").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Trace one extra round for forced style and layout per click and their top call sites, mapped through the build's sourcemaps. Writes trace.json beside the output.",
    ),
  ),
  skipBuild: Flag.Boolean("skip-build").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Serve the checkout's existing apps/web/dist instead of building it."),
  ),
};
const thresholdFlag = Flag.Int("threshold").pipe(
  Flag.withDescription("Percent a metric must move, past its floor, to count."),
  Flag.withDefault(10),
);

const casesOf = (list: string) => {
  const parsed = parseCases(list);
  return "error" in parsed
    ? Effect.fail(new MetricsError({ message: parsed.error }))
    : Effect.succeed(parsed.cases);
};

const runCommand = Command.make(
  "run",
  {
    ...measureFlags,
    out: Flag.String("out").pipe(Flag.withDescription("JSON file to write."), Flag.optional),
    checkout: Flag.String("checkout").pipe(
      Flag.withDescription("Checkout to measure, with dependencies installed."),
      Flag.optional,
    ),
  },
  Effect.fn("clientMetrics.run")(function* (input) {
    const path = yield* Path.Path;
    const checkout = path.resolve(
      Option.getOrElse(input.checkout, () => path.resolve(import.meta.dirname, "..")),
    );
    const cases = yield* casesOf(input.cases);
    const meta = yield* metaFor(checkout);
    if (!input.skipBuild) yield* buildWeb(checkout);
    const artifacts = Option.getOrUndefined(
      Option.map(input.out, (out) => `${path.resolve(out).replace(/\.json$/, "")}-artifacts`),
    );
    const measured = yield* measureOnce({
      checkout,
      root: yield* workRoot,
      cases,
      switchRounds: input.switchRounds,
      longTurns: input.longTurns,
      trace: input.trace,
      artifacts,
    });
    const metrics: ClientMetrics = {
      meta: { ...meta, chromium: measured.chromium, loadAfter: yield* machineLoad },
      runs: [measured.run],
      ...(measured.callSites ? { callSites: measured.callSites } : {}),
    };
    yield* writeMetrics(input.out, metrics);
    yield* Console.log(summaryTable(metrics));
  }),
).pipe(
  Command.withDescription(
    "Build a checkout's web app, seed a server with replayed threads, a large diff, a pull request on a fake GitHub and a local page, and measure thread switches, memory and renderer CPU in headless Chromium.",
  ),
);

const abCommand = Command.make(
  "ab",
  {
    ...measureFlags,
    checkoutA: Argument.String("checkout-a").pipe(Argument.withDescription("Baseline checkout.")),
    checkoutB: Argument.String("checkout-b").pipe(Argument.withDescription("Candidate checkout.")),
    rounds: Flag.Int("rounds").pipe(
      Flag.withSchema(PositiveInt),
      Flag.withDescription("Rounds; each runs A and B once, alternating which goes first."),
      Flag.withDefault(3),
    ),
    outDir: Flag.String("out-dir").pipe(
      Flag.withDescription("Directory for a.json and b.json."),
      Flag.withDefault("client-metrics-ab"),
    ),
    threshold: thresholdFlag,
  },
  Effect.fn("clientMetrics.ab")(function* (input) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outDir = path.resolve(input.outDir);
    yield* fs.makeDirectory(outDir, { recursive: true });
    const cases = yield* casesOf(input.cases);
    const checkouts = [path.resolve(input.checkoutA), path.resolve(input.checkoutB)] as const;
    const metas = [yield* metaFor(checkouts[0]), yield* metaFor(checkouts[1])] as const;
    if (!input.skipBuild) {
      yield* buildWeb(checkouts[0]);
      // The same checkout twice (an A/A run) builds once.
      if (checkouts[1] !== checkouts[0]) yield* buildWeb(checkouts[1]);
    }
    const root = yield* workRoot;
    let chromiumVersion: string | null = null;
    const callSites: [ReadonlyArray<CallSite> | undefined, ReadonlyArray<CallSite> | undefined] = [
      undefined,
      undefined,
    ];
    const saved = yield* runAbRounds({
      rounds: input.rounds,
      outDir,
      runSide: (side) =>
        measureOnce({
          checkout: checkouts[side],
          root,
          cases,
          switchRounds: input.switchRounds,
          longTurns: input.longTurns,
          trace: input.trace,
          artifacts: input.trace
            ? path.join(outDir, side === 0 ? "a-artifacts" : "b-artifacts")
            : undefined,
        }).pipe(
          Effect.map((measured) => {
            chromiumVersion = measured.chromium;
            callSites[side] = measured.callSites;
            return measured.run;
          }),
        ),
      save: Effect.fn("clientMetrics.abSave")(function* (side, runs) {
        const sideCallSites = callSites[side];
        const file: ClientMetrics = {
          meta: { ...metas[side], chromium: chromiumVersion, loadAfter: yield* machineLoad },
          runs: [...runs],
          ...(sideCallSites ? { callSites: sideCallSites } : {}),
        };
        yield* writeMetrics(Option.some(path.join(outDir, side === 0 ? "a.json" : "b.json")), file);
        return file;
      }),
    });
    yield* report(saved[0], saved[1], input.threshold);
  }),
).pipe(
  Command.withDescription(
    "Run two checkouts alternately (A B, then B A) on this machine and compare them. The harness, seed and replay agent come from this script, so an older checkout works too.",
  ),
);

const compareCommand = Command.make(
  "compare",
  {
    before: Argument.String("before").pipe(Argument.withDescription("Baseline JSON.")),
    after: Argument.String("after").pipe(Argument.withDescription("Candidate JSON.")),
    threshold: thresholdFlag,
  },
  Effect.fn("clientMetrics.compare")(function* (input) {
    const fs = yield* FileSystem.FileSystem;
    const read = (file: string) => fs.readFileString(file).pipe(Effect.flatMap(decodeMetrics));
    yield* report(yield* read(input.before), yield* read(input.after), input.threshold);
  }),
).pipe(
  Command.withDescription(
    "Markdown table of two result files, lower is better. With 2+ samples a side, a metric counts only when the 95% bootstrap interval of the median difference clears the threshold and its floor. Exits 1 on a regression.",
  ),
);

const summaryCommand = Command.make(
  "summary",
  { file: Argument.String("file").pipe(Argument.withDescription("A result JSON.")) },
  Effect.fn("clientMetrics.summary")(function* (input) {
    const fs = yield* FileSystem.FileSystem;
    const metrics = yield* fs.readFileString(input.file).pipe(Effect.flatMap(decodeMetrics));
    yield* Console.log(summaryTable(metrics));
  }),
).pipe(Command.withDescription("Print a result file's per-case table."));

const clientMetricsCommand = Command.make("client-metrics").pipe(
  Command.withDescription(
    `Measure the web client in headless Chromium against a production build and a seeded server. Linux and macOS.

Cases (each its own thread, switched to from a small hub thread by a sidebar click):
  short, long     Panel closed; one turn, and many heavy turns: the timeline's cost.
  working         A thread streaming a long replayed turn while it is measured.
  approval        A thread waiting on an approval.
  medium          Panel closed, the same timeline as the panel cases: their baseline.
  diff            Diff panel on a branch changing 40 files.
  pull-request    Pull request panel with a long body, files, commits and comments (fake GitHub).
  browser         Browser surface on a local page.
  device          Device surface; no device stream exists here, so it shows its empty state (light).

Trust a change only from \`ab\` on one machine.`,
  ),
  Command.withSubcommands([runCommand, abCommand, compareCommand, summaryCommand]),
);

if (import.meta.main) {
  Command.run(clientMetricsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici)),
    Effect.catchTags({
      MetricsError: (error) =>
        Console.error(`client-metrics: ${error.message}`).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
    }),
    NodeRuntime.runMain,
  );
}
