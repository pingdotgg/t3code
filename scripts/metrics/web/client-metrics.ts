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

import { DOM_CENSUS, Census, ProbeReading, RENDER_PROBE, rendersOf } from "./probes.ts";
import {
  CASES,
  ClientMetrics,
  compareClientMetrics,
  isSwitchCase,
  noiseReport,
  parseCases,
  summaryTable,
  PROBE_KEYS,
  WORKLOAD_KEYS,
  workloadDifferences,
  type Case,
  type Idle,
  type InteractionCase,
  type Memory,
  type Panel,
  type Run,
  type SoakSample,
  type Step,
  type Switch,
  type SwitchCase,
} from "./report.ts";
import { analyzeTrace, END_LABEL, MARK_PREFIX, Trace, type CallSite } from "./trace.ts";
import { prepareHome, SCENARIO_MACHINE_ENV } from "../../scenarios/start-app.ts";
import { run } from "../../scenarios/shell.ts";
import { DIFF_FILES, pullRequestDetail, sourceFile } from "../core/fixture.ts";
import { serveFakeGitHub } from "../core/forge.ts";
import { describeFailure, Floors, loadWarnings } from "../core/report.ts";
import {
  descendantsOf,
  freePort,
  machineLoad,
  MetricsError,
  nowMs,
  output,
  runAbRounds,
  watchMachine,
} from "../core/run.ts";

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
const encodeMetrics = Schema.encodeEffect(fromJsonStringPretty(ClientMetrics));
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const decodeObject = Schema.decodeUnknownEffect(JsonObject);
const decodeSettings = decodeJson(JsonObject);
const decodeLaunched = decodeJson(Schema.Struct({ threadId: Schema.String }));
const decodeThreadShown = decodeJson(
  Schema.Struct({ thread: Schema.Struct({ status: Schema.String }) }),
);
const decodeTrace = decodeJson(Trace);
const decodeMetrics = decodeJson(ClientMetrics);
const decodeFloors = decodeJson(Floors);
const encodeFloors = Schema.encodeEffect(fromJsonStringPretty(Floors));

/** The harness's own replay agent, so an older checkout still plays the bench recordings. */
const REPLAY_AGENT = new URL("../../../apps/server/scripts/dev-replay-agent.ts", import.meta.url);
const VIEWPORT = { width: 1512, height: 900 };
/** How long a switch is watched: probes read the frames and long frames in this window. */
const SETTLE_MS = 1_600;
const IDLE_SECONDS = 10;

const browserPromise = <A>(what: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new MetricsError({ message: `${what}: ${describeFailure(cause)}` }),
  });

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

/** Builds a checkout's web app for production, sourcemaps on; unminified keeps component names. */
const buildWeb = Effect.fn("clientMetrics.buildWeb")(function* (checkout: string, minify: boolean) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const environment = yield* HostProcess.Environment;
  const web = path.join(checkout, "apps/web");
  yield* Console.error(`building ${web} for production...`);
  const env = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !["HYAKKI_WEB_SOURCEMAP", "VITE_HTTP_URL", "VITE_WS_URL"].includes(entry[0]),
    ),
  );
  yield* run("vp", minify ? ["build"] : ["build", "--minify", "false"], { cwd: web, env });
  if (!(yield* fs.exists(path.join(web, "dist/index.html")))) {
    return yield* new MetricsError({ message: `${web}/dist has no index.html after the build` });
  }
});

/** Whether the served build's entry script is minified: its lines run long. */
const isMinified = Effect.fn("clientMetrics.isMinified")(function* (checkout: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dist = path.join(checkout, "apps/web/dist");
  const html = yield* fs.readFileString(path.join(dist, "index.html"));
  const entry = /<script[^>]+src="\/?([^"]+\.js)"/.exec(html)?.[1];
  if (entry === undefined) return null;
  const source = yield* fs.readFileString(path.join(dist, entry));
  return source.length / Math.max(1, source.split("\n").length) > 400;
});

/** Threads the seed creates: one per switch case, the hub, and one with two panel surfaces. */
type ThreadName = SwitchCase | "hub" | "surfaces";

interface Seeded {
  readonly origin: string;
  readonly environmentId: string;
  readonly pairingUrl: string;
  readonly threads: Readonly<Record<ThreadName, string>>;
  readonly fixtureUrl: string;
  /** The working thread's status from the server, `running` while its replayed turn streams. */
  readonly workingStatus: Effect.Effect<string, MetricsError>;
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
  const author = ["-c", "user.email=bench@hyakki.ryoku.dev", "-c", "user.name=bench"];
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

  const dropped = new Set(["HYAKKI_HOME", "XDG_CONFIG_HOME", "VITE_HTTP_URL", "VITE_WS_URL"]);
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
    HYAKKI_DEV_SEED: "0",
    HYAKKI_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
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
    Effect.catch((cause) =>
      Effect.gen(function* () {
        // Kept out of the message, which logs print; the file survives the run's temp home.
        const log = path.join(root, "server-stderr.log");
        const text = yield* Ref.get(stderr);
        yield* fs.writeFileString(log, text).pipe(Effect.ignore);
        return yield* new MetricsError({
          message: `server never served the web app; its last ${text.length} characters of stderr are in ${log}`,
          cause,
        });
      }),
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
    }).pipe(Effect.mapError((error) => new MetricsError({ message: error.message, cause: error })));
  const threadIdOf = (stdout: string) =>
    decodeLaunched(stdout).pipe(
      Effect.map(({ threadId }) => threadId),
      Effect.mapError(
        (cause) =>
          new MetricsError({
            message: `thread start printed no thread id (${stdout.length} characters of output)`,
            cause,
          }),
      ),
    );
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
    const threadId = yield* threadIdOf(started.stdout);
    for (let turn = 1; turn < turns; turn++) {
      yield* cli(["thread", "send", threadId, `Turn ${turn + 1}`, "--wait", "--json"], [0, 2]);
    }
    return threadId;
  });
  yield* Console.error("seeding threads through the CLI...");
  const plan: ReadonlyArray<readonly [ThreadName, string, number]> = [
    ["hub", "multi-turn", 1],
    ["surfaces", "multi-turn", 1],
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
  ]).pipe(Effect.flatMap(({ stdout }) => threadIdOf(stdout)));
  const threads = Object.fromEntries([...ids, ["working", working]]) as Record<ThreadName, string>;
  // Its output carries a pairing token, so errors name only its exit and length.
  const pair = yield* cli(["pair", "--label", "client-metrics"]).pipe(
    Effect.mapError(
      (error) => new MetricsError({ message: "pair failed", cause: error.cause ?? error }),
    ),
  );
  const pairingUrl = /https?:\/\/\S+\/pair#token=\S+/.exec(pair.stdout)?.[0];
  if (!pairingUrl) {
    return yield* new MetricsError({
      message: `pair exited ${pair.exitCode} without a pairing URL (${pair.stdout.length} characters of output)`,
    });
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
    workingStatus: cli(["thread", "show", working, "--messages", "0", "--json"]).pipe(
      Effect.flatMap(({ stdout }) => decodeThreadShown(stdout)),
      Effect.map(({ thread }) => thread.status),
      Effect.mapError(
        (cause) => new MetricsError({ message: "read the working thread's status", cause }),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ),
  };
  return seeded;
});

/**
 * In-page probes: Event Timing, long animation frames, a rAF watch on each switch, and
 * `begin`/`end` around an interaction step (slowest input-to-paint, LoAF and missed frames).
 */
const INSTALL_PROBES = `(() => {
  const bench = { events: [], loaf: [], last: null, step: null };
  window.__clientMetrics = bench;
  // Entries are kept only while a measurement watches, so soak heap samples hold none.
  const record = (on) => {
    bench.recording = on;
    bench.events = [];
    bench.loaf = [];
  };
  bench.record = record;
  record(false);
  new PerformanceObserver((list) => {
    if (!bench.recording) return;
    for (const entry of list.getEntries()) {
      bench.events.push({ name: entry.name, start: entry.startTime, duration: entry.duration, interaction: entry.interactionId ?? 0 });
    }
  }).observe({ type: "event", durationThreshold: 16, buffered: false });
  new PerformanceObserver((list) => {
    if (!bench.recording) return;
    for (const entry of list.getEntries()) bench.loaf.push({ start: entry.startTime, duration: entry.duration });
  }).observe({ type: "long-animation-frame", buffered: false });
  // The click's own timestamp, so the press's hold does not count; Event Timing skips fast clicks.
  addEventListener("click", (event) => {
    if (bench.last && bench.last.clickAt === null) bench.last.clickAt = event.timeStamp;
  }, true);
  bench.watch = (fromPath) => {
    record(true);
    const t0 = performance.now();
    const watch = { t0, clickAt: null, frames: [] };
    const tick = (ts) => {
      // ts is the frame's begin time, which can precede the click whose long task delayed it.
      watch.frames.push({
        ts,
        at: performance.now(),
        moved: location.pathname !== fromPath,
        rows: document.querySelectorAll("[data-timeline-row-id]").length,
        loading: document.querySelector("[data-timeline-loading]") !== null,
      });
      if (ts - t0 < ${SETTLE_MS + 900}) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    bench.last = watch;
  };
  bench.begin = () => {
    record(true);
    const step = { t0: performance.now(), frames: [], done: false };
    const tick = (ts) => {
      if (step.done) return;
      step.frames.push(ts);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    bench.step = step;
  };
  // A step whose input failed: stop its frame loop and drop what it saw.
  bench.abort = () => {
    if (bench.step) bench.step.done = true;
    record(false);
  };
  // Two frames later, so the observers have delivered the step's last entries.
  bench.end = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
    const step = bench.step;
    step.done = true;
    const inStep = (entry) => entry.start >= step.t0 - 5;
    const paints = bench.events.filter((entry) => inStep(entry) && entry.interaction > 0).map((entry) => entry.duration);
    const loaf = bench.loaf.filter(inStep).reduce((sum, entry) => sum + entry.duration, 0);
    let dropped = 0;
    for (let index = 1; index < step.frames.length; index++) {
      dropped += Math.max(0, Math.round((step.frames[index] - step.frames[index - 1]) / (1000 / 60)) - 1);
    }
    const intervals = Math.max(1, step.frames.length - 1);
    record(false);
    resolve({
      paintMs: paints.length ? Math.round(Math.max(...paints)) : null,
      loafMs: Math.round(loaf),
      droppedPct: Math.round((dropped / (dropped + intervals)) * 1000) / 10,
    });
  })));
})()`;

/** How long after the click a switch's long animation frames count. */
const LOAF_WINDOW_MS = 1_500;

const READ_SWITCH = `(() => {
  const bench = window.__clientMetrics;
  const watch = bench.last;
  const at = location.pathname;
  if (watch.clickAt === null) {
    bench.record(false);
    return { clicked: false, at };
  }
  const clickAt = watch.clickAt;
  const event = bench.events.find((entry) => entry.name === "click" && entry.start >= clickAt - 5);
  const moved = watch.frames.find((frame) => frame.moved);
  const content = watch.frames.find((frame) => frame.moved && frame.rows > 0 && !frame.loading);
  const from = clickAt - 5;
  const to = clickAt + ${LOAF_WINDOW_MS};
  const loaf = bench.loaf.reduce(
    (sum, entry) => sum + Math.max(0, Math.min(entry.start + entry.duration, to) - Math.max(entry.start, from)),
    0,
  );
  bench.record(false);
  return {
    clicked: true,
    at,
    reading: {
      paintMs: event ? Math.round(event.duration) : null,
      contentMs: content ? Math.max(0, Math.round(content.at - clickAt)) : null,
      firstFrameContent: Boolean(moved && content && moved === content),
      loafMs: Math.round(loaf),
    },
  };
})()`;
const SwitchReading = Schema.Struct({
  paintMs: Schema.NullOr(Schema.Number),
  contentMs: Schema.NullOr(Schema.Number),
  firstFrameContent: Schema.Boolean,
  loafMs: Schema.Number,
});
const SwitchRead = Schema.Union([
  Schema.Struct({ clicked: Schema.Literal(false), at: Schema.String }),
  Schema.Struct({ clicked: Schema.Literal(true), at: Schema.String, reading: SwitchReading }),
]);
const StepReading = Schema.Struct({
  paintMs: Schema.NullOr(Schema.Number),
  loafMs: Schema.Number,
  droppedPct: Schema.Number,
});

const evaluate = <S extends Schema.Top>(page: Page, script: string, schema: S) =>
  browserPromise("page script", () => page.evaluate(script)).pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(schema)(value)),
    Effect.mapError((error) =>
      error._tag === "MetricsError" ? error : new MetricsError({ message: `${error}` }),
    ),
  );

const memoryAfterGc = Effect.fn("clientMetrics.memory")(function* (page: Page, cdp: CDPSession) {
  yield* browserPromise("collect garbage", async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    await cdp.send("HeapProfiler.collectGarbage");
  });
  const heap = yield* evaluate(page, "performance.memory.usedJSHeapSize", Schema.Number);
  const counters = yield* browserPromise("DOM counters", () => cdp.send("Memory.getDOMCounters"));
  return {
    heapMB: Math.round(heap / 1e5) / 10,
    domNodes: counters.nodes,
    listeners: counters.jsEventListeners,
  };
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

/** One page under test and what its probes collected. */
interface Harness {
  readonly page: Page;
  readonly seeded: Seeded;
  /** Set with `--renders`: components whose changed hook slots are diffed (`--slot-diff`). */
  readonly renders: { readonly slotNames: ReadonlyArray<string> } | undefined;
  /** Every full render reading, for the artifacts. */
  readonly probeLog: Array<{ readonly label: string; readonly round: number } & ProbeReading>;
}

/**
 * How a step runs: measured (recorded with its round), marked for the traced round, or plain
 * (warm-up and soak).
 */
type Mode =
  | { readonly kind: "measure"; readonly round: number }
  | { readonly kind: "trace" }
  | { readonly kind: "plain" };

const mark = (page: Page, label: string) =>
  browserPromise("mark", () =>
    page.evaluate(`performance.mark(${JSON.stringify(`${MARK_PREFIX}${label}`)})`),
  );

const startRenders = (h: Harness) =>
  h.renders === undefined
    ? Effect.void
    : browserPromise("render probe start", () =>
        h.page.evaluate(
          `window.__clientMetricsRenders.start(${JSON.stringify(h.renders?.slotNames ?? [])})`,
        ),
      );

const stopRenders = Effect.fn("clientMetrics.stopRenders")(function* (
  h: Harness,
  label: string,
  round: number,
) {
  if (h.renders === undefined) return undefined;
  const reading = yield* evaluate(h.page, "window.__clientMetricsRenders.stop()", ProbeReading);
  h.probeLog.push({ label, round, ...reading });
  return rendersOf(reading);
});

/** Whether a page path is a thread's route; ids like `mcp:<uuid>` are percent-encoded in it. */
const isThreadPath = (path: string, threadId: string) =>
  decodeURIComponent(path).endsWith(`/${threadId}`);

const rowKeyOf = (seeded: Seeded, name: ThreadName) =>
  `${seeded.environmentId}:${seeded.threads[name]}`;

/** Opens a thread the way a person does: pointer onto its sidebar row, rest, press, release. */
const clickRow = Effect.fn("clientMetrics.clickRow")(function* (
  h: Harness,
  name: ThreadName,
  mode: Mode,
) {
  const { page } = h;
  const rowKey = rowKeyOf(h.seeded, name);
  const row = page.locator(`[data-sidebar-row="${rowKey}"]`).first();
  yield* browserPromise(`sidebar row ${name}`, () =>
    row.scrollIntoViewIfNeeded({ timeout: 10_000 }),
  );
  const box = yield* browserPromise("row box", () => row.boundingBox());
  if (box === null) return yield* new MetricsError({ message: `sidebar row ${name} is hidden` });
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 14);
  yield* browserPromise("pointer", async () => {
    await page.mouse.move(x - 40, y);
    await page.mouse.move(x, y, { steps: 4 });
  });
  yield* Effect.sleep(Duration.millis(350));
  if (mode.kind === "trace") yield* mark(page, `switch:${name}`);
  if (mode.kind === "measure") {
    yield* browserPromise("watch", () =>
      page.evaluate(`window.__clientMetrics.watch(location.pathname)`),
    );
    yield* startRenders(h);
  }
  yield* browserPromise("press", async () => {
    await page.mouse.down();
    await page.waitForTimeout(80);
    await page.mouse.up();
  });
  yield* Effect.sleep(Duration.millis(SETTLE_MS));
  if (mode.kind === "trace") yield* mark(page, END_LABEL);
  if (mode.kind !== "measure") return undefined;
  const read = yield* evaluate(page, READ_SWITCH, SwitchRead);
  // A switch that never happened fails the run rather than recording a sample under its name.
  if (!read.clicked) {
    return yield* new MetricsError({ message: `switch to ${name}: the page saw no click` });
  }
  if (!isThreadPath(read.at, h.seeded.threads[name])) {
    return yield* new MetricsError({
      message: `switch to ${name}: the click left the page at ${read.at}`,
    });
  }
  const renders = yield* stopRenders(h, `switch:${name}`, mode.round);
  return { ...read.reading, ...(renders === undefined ? {} : { renders }) };
});

const onThread = Effect.fn("clientMetrics.onThread")(function* (h: Harness, name: ThreadName) {
  const at = evaluate(h.page, "location.pathname", Schema.String);
  const opened = (path: string) => isThreadPath(path, h.seeded.threads[name]);
  if (opened(yield* at)) return;
  yield* clickRow(h, name, { kind: "plain" });
  const now = yield* at;
  if (!opened(now)) {
    return yield* new MetricsError({ message: `opening ${name} left the page at ${now}` });
  }
});

/**
 * One step of an interaction: `act` sends the input, then the page settles for `settleMs`. A
 * measured step records its slowest input-to-paint, LoAF, missed frames and renders.
 */
const runStep = Effect.fn("clientMetrics.step")(function* (
  h: Harness,
  mode: Mode,
  steps: Step[],
  name: InteractionCase,
  step: string,
  act: () => Promise<unknown>,
  settleMs: number,
) {
  if (mode.kind === "trace") yield* mark(h.page, `${name}:${step}`);
  if (mode.kind === "measure") {
    yield* browserPromise("begin step", () => h.page.evaluate("window.__clientMetrics.begin()"));
    yield* startRenders(h);
  }
  yield* browserPromise(`${name} ${step}`, act).pipe(
    Effect.tapError(() =>
      mode.kind !== "measure"
        ? Effect.void
        : browserPromise("abort step", () =>
            h.page.evaluate(
              "window.__clientMetrics.abort(); window.__clientMetricsRenders?.stop()",
            ),
          ).pipe(Effect.ignore),
    ),
  );
  yield* Effect.sleep(Duration.millis(settleMs));
  if (mode.kind === "trace") yield* mark(h.page, END_LABEL);
  if (mode.kind !== "measure") return;
  const reading = yield* evaluate(h.page, "window.__clientMetrics.end()", StepReading);
  const renders = yield* stopRenders(h, `${name}:${step}`, mode.round);
  steps.push({
    case: name,
    step,
    round: mode.round,
    ...reading,
    ...(renders === undefined ? {} : { renders }),
  });
});

/** Fails with a readable message unless `selector` shows up. */
const expectVisible = (h: Harness, what: string, selector: string, timeout = 5_000) =>
  browserPromise(what, () => h.page.locator(selector).first().waitFor({ timeout }));

const TYPED = "check the helpers";
const KEY_SETTLE_MS = 120;

type Driver = (h: Harness, mode: Mode, steps: Step[]) => Effect.Effect<void, MetricsError>;

/** Types into the composer one key at a time, as fast as a person, then clears it. */
const typeInComposer = (name: InteractionCase): Driver =>
  Effect.fn("clientMetrics.type")(function* (h: Harness, mode: Mode, steps: Step[]) {
    const composer = h.page.locator('.ProseMirror[contenteditable="true"]').first();
    yield* browserPromise("focus the composer", () => composer.click({ timeout: 10_000 }));
    for (const key of TYPED) {
      yield* runStep(h, mode, steps, name, "key", () => h.page.keyboard.press(key), KEY_SETTLE_MS);
    }
    yield* browserPromise("clear the composer", async () => {
      await h.page.keyboard.press("ControlOrMeta+a");
      await h.page.keyboard.press("Backspace");
      await h.page.waitForTimeout(300);
    });
  });

const INTERACTIONS: Record<InteractionCase, { readonly thread: ThreadName; readonly run: Driver }> =
  {
    "type-short": { thread: "short", run: typeInComposer("type-short") },
    "type-long": { thread: "long", run: typeInComposer("type-long") },
    "scroll-long": {
      thread: "long",
      // Wheels up a fixed distance from the bottom, through rows the timeline has to lay out.
      run: Effect.fn("clientMetrics.interaction")(function* (
        h: Harness,
        mode: Mode,
        steps: Step[],
      ) {
        const scroller = h.page.locator(".messages-timeline-scroll").first();
        const toBottom = () =>
          scroller.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
        yield* browserPromise("scroll to the bottom", async () => {
          await toBottom();
          await h.page.waitForTimeout(600);
        });
        const box = yield* browserPromise("timeline box", () => scroller.boundingBox());
        if (box === null) return yield* new MetricsError({ message: "the timeline is hidden" });
        yield* browserPromise("pointer over the timeline", () =>
          h.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2),
        );
        yield* runStep(
          h,
          mode,
          steps,
          "scroll-long",
          "wheel-up",
          async () => {
            for (let tick = 0; tick < 25; tick++) {
              await h.page.mouse.wheel(0, -240);
              await h.page.waitForTimeout(16);
            }
          },
          400,
        );
        yield* browserPromise("back to the bottom", async () => {
          await toBottom();
          await h.page.waitForTimeout(400);
        });
      }),
    },
    palette: {
      thread: "hub",
      run: Effect.fn("clientMetrics.interaction")(function* (
        h: Harness,
        mode: Mode,
        steps: Step[],
      ) {
        yield* runStep(
          h,
          mode,
          steps,
          "palette",
          "open",
          () => h.page.keyboard.press("ControlOrMeta+k"),
          800,
        );
        yield* expectVisible(h, "the command palette input", '[role="dialog"] input');
        for (const key of "bench") {
          yield* runStep(
            h,
            mode,
            steps,
            "palette",
            "key",
            () => h.page.keyboard.press(key),
            KEY_SETTLE_MS,
          );
        }
        // Chat shortcuts ignore keys until the palette unmounts, closing animation included.
        yield* browserPromise("close the palette", async () => {
          await h.page.keyboard.press("Escape");
          await h.page
            .locator("[data-command-palette]")
            .first()
            .waitFor({ state: "detached", timeout: 5_000 });
        });
      }),
    },
    "pr-tabs": {
      thread: "pull-request",
      // Ends on Summary, where the pull-request switch case expects the panel.
      run: Effect.fn("clientMetrics.interaction")(function* (
        h: Harness,
        mode: Mode,
        steps: Step[],
      ) {
        for (const tab of ["Timeline", "Code", "Summary"]) {
          const button = h.page
            .locator("[data-right-panel-surface-content] button", {
              hasText: new RegExp(`^${tab}$`),
            })
            .first();
          yield* runStep(
            h,
            mode,
            steps,
            "pr-tabs",
            tab.toLowerCase(),
            () => button.click({ timeout: 10_000 }),
            1_200,
          );
        }
      }),
    },
    surfaces: {
      thread: "surfaces",
      run: Effect.fn("clientMetrics.interaction")(function* (
        h: Harness,
        mode: Mode,
        steps: Step[],
      ) {
        for (const [step, label] of [
          ["to-pull-request", "#1"],
          ["to-diff", "Diff"],
        ] as const) {
          const tab = h.page
            .locator("[data-right-panel-tab-list] button", {
              hasText: new RegExp(`^${label.replace("#", "\\#")}$`),
            })
            .first();
          yield* runStep(
            h,
            mode,
            steps,
            "surfaces",
            step,
            () => tab.click({ timeout: 10_000 }),
            1_200,
          );
        }
      }),
    },
    terminal: {
      thread: "hub",
      run: Effect.fn("clientMetrics.interaction")(function* (
        h: Harness,
        mode: Mode,
        steps: Step[],
      ) {
        const toggle = () => h.page.keyboard.press("ControlOrMeta+j");
        yield* runStep(h, mode, steps, "terminal", "open", toggle, 1_200);
        yield* expectVisible(h, "the terminal drawer", 'aside[data-terminal-owner="drawer"]');
        yield* runStep(h, mode, steps, "terminal", "close", toggle, 800);
      }),
    },
    settings: {
      thread: "hub",
      run: Effect.fn("clientMetrics.interaction")(function* (
        h: Harness,
        mode: Mode,
        steps: Step[],
      ) {
        const settings = h.page.getByRole("button", { name: "Settings", exact: true }).first();
        yield* runStep(
          h,
          mode,
          steps,
          "settings",
          "open",
          () => settings.click({ timeout: 10_000 }),
          1_200,
        );
        const at = yield* evaluate(h.page, "location.pathname", Schema.String);
        if (!at.startsWith("/settings")) {
          return yield* new MetricsError({ message: `Settings opened ${at}` });
        }
        yield* runStep(
          h,
          mode,
          steps,
          "settings",
          "back",
          () => h.page.keyboard.press("Escape"),
          1_200,
        );
      }),
    },
  };

const threadOf = (name: Case): ThreadName =>
  isSwitchCase(name) ? name : INTERACTIONS[name].thread;

const PANEL_LAUNCHERS: Partial<Record<ThreadName, string>> = {
  diff: "Diff",
  "pull-request": "Pull request",
  browser: "Browser",
  device: "Device",
  surfaces: "Pull request",
};

/** The threads whose right panel a case needs open. */
const panelThreads = (cases: ReadonlyArray<Case>) => [
  ...new Set(
    cases.flatMap((name): ThreadName[] =>
      name === "pr-tabs"
        ? ["pull-request"]
        : PANEL_LAUNCHERS[threadOf(name)]
          ? [threadOf(name)]
          : [],
    ),
  ),
];

/**
 * Opens a thread's panel through the right panel launcher, as a person would. The surfaces thread
 * gets a Diff surface beside its pull request.
 */
const openPanel = Effect.fn("clientMetrics.openPanel")(function* (
  h: Harness,
  name: ThreadName,
  artifacts: string | undefined,
) {
  const path = yield* Path.Path;
  const { page, seeded } = h;
  const label = PANEL_LAUNCHERS[name]!;
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
    if (name === "surfaces") {
      await page.waitForTimeout(1_000);
      await page.getByRole("button", { name: "Add panel surface" }).click();
      await page.getByRole("menuitem", { name: /^Diff/ }).first().click({ timeout: 10_000 });
    }
    await page.waitForTimeout(3_000);
    if (artifacts !== undefined) {
      await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
    }
  });
});

/** Counts the open surface's DOM. */
const panelCensus = Effect.fn("clientMetrics.panelCensus")(function* (
  h: Harness,
  name: ThreadName,
  artifacts: string | undefined,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const census = yield* evaluate(h.page, DOM_CENSUS, Census);
  if (artifacts !== undefined) {
    yield* fs.writeFileString(
      path.join(artifacts, `${name}.census.json`),
      `${encodeJson(census)}\n`,
    );
  }
  return {
    case: name,
    panelNodes: census.panelNodes,
    documentNodes: census.documentNodes,
  } satisfies Panel;
});

const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.stack",
  "v8.execute",
  "disabled-by-default-v8.cpu_profiler",
  "blink.user_timing",
  "loading",
  "latencyInfo",
];

const SourceMapJson = Schema.Struct({
  version: Schema.Number,
  file: Schema.optional(Schema.String),
  sourceRoot: Schema.optional(Schema.String),
  sources: Schema.Array(Schema.String),
  names: Schema.Array(Schema.String),
  mappings: Schema.String,
});

const decodeSourceMap = decodeJson(SourceMapJson);

/** Maps generated positions through the build's sourcemaps to paths relative to the checkout. */
const loadSourceMaps = Effect.fn("clientMetrics.loadSourceMaps")(function* (
  checkout: string,
  assets: string,
  urls: ReadonlySet<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const maps = new Map<string, NodeModule.SourceMap>();
  const fileOf = (url: string) => url.split("/").pop()?.split("?")[0] ?? "";
  for (const url of urls) {
    const file = fileOf(url);
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
    const entry = maps.get(fileOf(url))?.findEntry(line, column);
    if (entry === undefined || !("originalSource" in entry)) return undefined;
    // Sources sit relative to the map in apps/web/dist/assets.
    return {
      source: path.relative(checkout, path.resolve(assets, entry.originalSource)),
      line: entry.originalLine,
    };
  };
});

interface MeasureOptions {
  readonly checkout: string;
  readonly root: string;
  readonly cases: ReadonlyArray<Case>;
  readonly switchRounds: number;
  readonly longTurns: number;
  readonly trace: boolean;
  readonly renders: boolean;
  readonly slotNames: ReadonlyArray<string>;
  readonly soak: number;
  /** Where screenshots, censuses, render logs and the trace go; none keeps nothing. */
  readonly artifacts: string | undefined;
}

/**
 * V8 tiers that compile hot functions to machine code. Code space grows for dozens of soak
 * iterations as more functions get hot, which reads as a heap leak; with them off the heap is flat.
 */
const NO_JIT_TIERS = "--js-flags=--no-opt --no-maglev --no-sparkplug";

/**
 * One measured run on a fresh server and browser. `--soak` repeats in a second pass whose browser
 * runs JS interpreted, so its heap tracks retained objects and not compiled code; that pass's
 * timings are discarded.
 */
const measureOnce = Effect.fn("clientMetrics.measureOnce")(function* (options: MeasureOptions) {
  const measured = yield* measurePass({ ...options, soak: 0 });
  if (options.soak === 0) return measured;
  yield* Console.error("soaking in a second browser with V8's compiling tiers off...");
  const soaked = yield* measurePass({
    ...options,
    switchRounds: 1,
    trace: false,
    renders: false,
    artifacts: undefined,
  });
  const measuredSkips = measured.run.skipped ?? [];
  const skipped = [
    ...measuredSkips,
    ...(soaked.run.skipped ?? []).flatMap((entry) =>
      measuredSkips.some((other) => other.case === entry.case)
        ? []
        : [{ case: entry.case, reason: `in the soak: ${entry.reason}` }],
    ),
  ];
  return {
    ...measured,
    run: {
      ...measured.run,
      ...(soaked.run.soak === undefined ? {} : { soak: soaked.run.soak }),
      ...(skipped.length === 0 ? {} : { skipped }),
    },
  };
});

const measurePass = Effect.fn("clientMetrics.measurePass")(function* (options: MeasureOptions) {
  const soaking = options.soak > 0;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const machine = yield* watchMachine;
  const seeded = yield* startSeededApp(options.checkout, options.root, options.longTurns);
  if (options.artifacts !== undefined) {
    yield* fs.makeDirectory(options.artifacts, { recursive: true });
  }
  const browser = yield* Effect.acquireRelease(
    browserPromise("launch Chromium", () =>
      chromium.launch({
        headless: true,
        args: [
          "--enable-gpu-rasterization",
          "--enable-precise-memory-info",
          ...(soaking ? [NO_JIT_TIERS] : []),
        ],
      }),
    ),
    (launched: Browser) => Effect.promise(() => launched.close()).pipe(Effect.ignore),
  );
  const context = yield* browserPromise("browser context", () =>
    browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 }),
  );
  const page = yield* browserPromise("page", () => context.newPage());
  if (options.renders) {
    yield* browserPromise("render probe", () => page.addInitScript(RENDER_PROBE));
  }
  const h: Harness = {
    page,
    seeded,
    renders: options.renders ? { slotNames: options.slotNames } : undefined,
    probeLog: [],
  };
  yield* browserPromise("pair", async () => {
    await page.goto(seeded.pairingUrl);
    await page.waitForSelector("[data-sidebar-row]", { timeout: 90_000 });
  });
  const skipped: Array<{ case: string; reason: string }> = [];
  let cases = options.cases;
  const skip = Effect.fn("clientMetrics.skip")(function* (name: Case, reason: string) {
    skipped.push({ case: name, reason });
    cases = cases.filter((entry) => entry !== name);
    yield* Console.error(`skipping ${name}: ${reason}`);
  });

  // A panel this checkout cannot open skips only the cases that need it.
  const panels: Panel[] = [];
  for (const thread of panelThreads(cases)) {
    const opened = yield* openPanel(h, thread, options.artifacts).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.as(
          Effect.forEach(
            cases.filter((name) => panelThreads([name]).includes(thread)),
            (name) =>
              skip(name, `its ${thread} panel did not open: ${error.message.split("\n")[0]!}`),
          ),
          false,
        ),
      ),
    );
    // Outside the catch: a census that cannot be read or saved fails the run.
    if (opened && thread !== "surfaces")
      panels.push(yield* panelCensus(h, thread, options.artifacts));
  }

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
  const needed = [...new Set<ThreadName>(["hub", ...cases.map(threadOf)])];
  const missingFrom = (rows: ReadonlyArray<string>) =>
    needed.filter((name) => !rows.includes(rowKeyOf(seeded, name)));
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
  const memory: Memory[] = [{ label: "loaded", ...(yield* memoryAfterGc(page, cdp)) }];
  const switches: Switch[] = [];
  const steps: Step[] = [];
  /** Interactions that failed in the traced round, whose marked windows the analysis drops. */
  const failedInTrace = new Set<string>();

  /** Runs a case once; an interaction this checkout cannot do is skipped from then on. */
  const runCase = Effect.fn("clientMetrics.runCase")(function* (name: Case, mode: Mode) {
    if (isSwitchCase(name)) {
      yield* onThread(h, "hub");
      const reading = yield* clickRow(h, name, mode);
      if (reading === undefined || mode.kind !== "measure") return;
      switches.push({
        case: name,
        visit: mode.round === 0 ? "first" : "revisit",
        round: mode.round,
        ...reading,
      });
      const content =
        reading.contentMs === null
          ? ", no timeline rows in the window"
          : reading.firstFrameContent
            ? ""
            : ", content after the first frame";
      yield* Console.error(
        `round ${mode.round + 1}/${options.switchRounds} ${name}: paint ${reading.paintMs ?? "<16"} ms, LoAF ${reading.loafMs} ms${content}${reading.renders ? `, ${reading.renders.renders} renders` : ""}`,
      );
      return;
    }
    const before = steps.length;
    const loggedBefore = h.probeLog.length;
    yield* onThread(h, INTERACTIONS[name].thread);
    yield* INTERACTIONS[name].run(h, mode, steps).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          steps.splice(before);
          h.probeLog.splice(loggedBefore);
          if (mode.kind === "trace") failedInTrace.add(name);
          yield* browserPromise("recover", async () => {
            await page.keyboard.press("Escape");
            await page.keyboard.press("Escape");
            await page.waitForTimeout(500);
          }).pipe(Effect.ignore);
          yield* skip(name, error.message.split("\n")[0]!);
        }),
      ),
    );
    if (mode.kind !== "measure" || steps.length === before) return;
    const taken = steps.slice(before);
    const paints = taken.flatMap((entry) => (entry.paintMs === null ? [] : [entry.paintMs]));
    yield* Console.error(
      `round ${mode.round + 1}/${options.switchRounds} ${name}: ${taken.length} steps, slowest paint ${paints.length ? Math.max(...paints) : "<16"} ms, LoAF ${taken.reduce((sum, entry) => sum + entry.loafMs, 0)} ms`,
    );
  });

  for (let round = 0; round < options.switchRounds; round++) {
    for (const name of cases) yield* runCase(name, { kind: "measure", round });
    if (round === 0) {
      memory.push({ label: "after first visits", ...(yield* memoryAfterGc(page, cdp)) });
    }
  }
  memory.push({
    label: "after every round",
    ...(yield* memoryAfterGc(page, cdp)),
  });

  let trace: Run["trace"];
  let callSites: ReadonlyArray<CallSite> | undefined;
  if (options.trace) {
    yield* Console.error("tracing one more round...");
    yield* onThread(h, "hub");
    yield* browserPromise("start tracing", () =>
      browser.startTracing(page, { screenshots: false, categories: TRACE_CATEGORIES }),
    );
    for (const name of cases) yield* runCase(name, { kind: "trace" });
    const buffer = yield* browserPromise("stop tracing", () => browser.stopTracing());
    const text = new TextDecoder().decode(buffer);
    if (options.artifacts !== undefined) {
      yield* fs.writeFileString(path.join(options.artifacts, "trace.json"), text);
    }
    const decoded = yield* decodeTrace(text).pipe(
      Effect.mapError((error) => new MetricsError({ message: `trace: ${error}` })),
    );
    const events = "traceEvents" in decoded ? decoded.traceEvents : decoded;
    const urls = new Set(
      events.flatMap((event) => [
        ...(event.args?.beginData?.stackTrace ?? []).map((frame) => frame.url),
        ...(event.args?.data?.cpuProfile?.nodes ?? []).flatMap((node) =>
          node.callFrame.url ? [node.callFrame.url] : [],
        ),
      ]),
    );
    const mapper = yield* loadSourceMaps(
      options.checkout,
      path.join(options.checkout, "apps/web/dist/assets"),
      urls,
    );
    const analyzed = analyzeTrace(events, mapper, { skipCases: failedInTrace });
    if (analyzed === undefined) {
      yield* Console.error("the trace has no renderer main thread; no CPU breakdown");
    } else {
      if (!analyzed.profiled) yield* Console.error("the trace has no CPU profile samples");
      trace = analyzed.steps;
      callSites = analyzed.callSites;
    }
  }

  const idle: Idle[] = [];
  if (cases.includes("working") && !soaking) {
    // Its replayed turn is finite; a window it did not stream through all along is dropped.
    for (const [thread, label] of [
      ["working", "on the working thread"],
      ["hub", "on an idle thread"],
    ] as const) {
      yield* onThread(h, thread);
      const before = yield* seeded.workingStatus;
      const sample = yield* idleCpu(cdp, label);
      const after = yield* seeded.workingStatus;
      if (before !== "running" || after !== "running") {
        const reason = `renderer CPU ${label}: the working thread was ${before === "running" ? after : before}, not streaming`;
        skipped.push({ case: "working", reason });
        yield* Console.error(`skipping ${reason}`);
        break;
      }
      idle.push(sample);
    }
  }

  let soak: SoakSample[] | undefined;
  if (options.soak > 0) {
    const every = Math.max(1, Math.floor(options.soak / 6));
    soak = [{ iteration: 0, ...(yield* memoryAfterGc(page, cdp)) }];
    for (let iteration = 1; iteration <= options.soak; iteration++) {
      for (const name of cases) yield* runCase(name, { kind: "plain" });
      if (iteration % every === 0 || iteration === options.soak) {
        const sample: SoakSample = { iteration, ...(yield* memoryAfterGc(page, cdp)) };
        soak.push(sample);
        yield* Console.error(
          `soak ${iteration}/${options.soak}: heap ${sample.heapMB} MB, ${sample.domNodes} DOM nodes, ${sample.listeners} listeners`,
        );
      }
    }
  }

  if (options.artifacts !== undefined && h.probeLog.length > 0) {
    yield* fs.writeFileString(
      path.join(options.artifacts, "renders.ndjson"),
      h.probeLog.map((entry) => encodeJson(entry)).join("\n") + "\n",
    );
  }
  const result: Run = {
    switches,
    steps,
    panels,
    memory,
    idle,
    ...(trace === undefined ? {} : { trace }),
    ...(soak === undefined ? {} : { soak }),
    ...(skipped.length === 0 ? {} : { skipped }),
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

const readFloors = Effect.fn("clientMetrics.readFloors")(function* (file: Option.Option<string>) {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isNone(file)) return undefined;
  return yield* fs.readFileString(file.value).pipe(Effect.flatMap(decodeFloors));
});

/** Prints the comparison and sets exit code 1 when a metric got worse. */
const report = Effect.fn("clientMetrics.report")(function* (
  before: ClientMetrics,
  after: ClientMetrics,
  threshold: number,
  floors: Floors | undefined,
) {
  const workload = workloadDifferences(before, after);
  if (workload.differ.length > 0) {
    return yield* new MetricsError({
      message: `the files ran different workloads (${workload.differ.join("; ")}); rerun one side with the other's settings`,
    });
  }
  const { table, regressed, improved, noisy, compared } = compareClientMetrics(
    before,
    after,
    threshold,
    floors,
  );
  yield* Console.log(table);
  for (const warning of [...loadWarnings("before", before), ...loadWarnings("after", after)]) {
    yield* Console.error(`Warning: ${warning}`);
  }
  if (workload.unrecorded.length > 0) {
    yield* Console.error(
      `Warning: one file does not record ${workload.unrecorded.join(", ")}; check both ran the same workload`,
    );
  }
  if (before.meta.renders !== after.meta.renders) {
    yield* Console.error(
      "Warning: one side ran with --renders, whose probe slows commits; compare like with like",
    );
  }
  if (floors !== undefined && floors.platform !== before.meta.platform) {
    yield* Console.error(
      `Warning: the floors were calibrated on ${floors.platform}, these files ran on ${before.meta.platform}`,
    );
  }
  if (compared === 0) {
    return yield* new MetricsError({ message: "the two files share no metric" });
  }
  if (noisy.length)
    yield* Console.error(
      `Moved, but not gated (too noisy, or one run a side): ${noisy.join(", ")}`,
    );
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
      "Rounds over every case per run: a switch's first round is its first visit, the rest revisits.",
    ),
    Flag.withDefault(4),
  ),
  longTurns: Flag.Int("long-turns").pipe(
    Flag.withSchema(PositiveInt),
    Flag.withDescription("Turns in the long thread, each a heavy recorded turn."),
    Flag.withDefault(12),
  ),
  cases: Flag.String("cases").pipe(
    Flag.withDescription(
      `Cases to run, comma separated: ${CASES.join(", ")}, or the groups switches and interactions. Default: all.`,
    ),
    Flag.withDefault(""),
  ),
  trace: Flag.Boolean("trace").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Trace one extra round with a CPU profile: per step, the input task's forced style and layout and its JS by source file and library, and the long tasks after it, mapped through the build's sourcemaps. Saves trace.json in the artifacts directory: `<out>-artifacts` for `run --out` (not saved without --out), a-artifacts and b-artifacts in `ab`'s out dir.",
    ),
  ),
  renders: Flag.Boolean("renders").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Count React commits and component renders per measured step, with their top components and causes. Near-deterministic, so compare gates on them; the probe slows commits a little, so compare like with like. Pair with --unminified for readable names.",
    ),
  ),
  slotDiff: Flag.String("slot-diff").pipe(
    Flag.withDescription(
      "With --renders, comma-separated components whose changed hook slots are deep-diffed into renders.ndjson beside the output.",
    ),
    Flag.withDefault(""),
  ),
  unminified: Flag.Boolean("unminified").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Build without minification (sourcemaps kept), so render counts and profiles name components. Slower than production; compare like with like.",
    ),
  ),
  soak: Flag.Int("soak").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    Flag.withDescription(
      "After measuring, repeat every case this many times in a second browser with V8's compiling tiers off (so compiled code does not read as a leak) and record heap, DOM nodes and listeners after GC along the way, with their growth per iteration over the soak's later half.",
    ),
    Flag.withDefault(0),
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
const floorsFlag = Flag.String("floors").pipe(
  Flag.withDescription("Floors file from `noise --out`; its metrics gate on calibrated floors."),
  Flag.optional,
);

const casesOf = (list: string) => {
  const parsed = parseCases(list);
  return "error" in parsed
    ? Effect.fail(new MetricsError({ message: parsed.error }))
    : Effect.succeed(parsed.cases);
};

const slotNamesOf = (list: string) =>
  list
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const measureMeta = Effect.fn("clientMetrics.measureMeta")(function* (
  checkout: string,
  workload: {
    readonly renders: boolean;
    readonly cases: ReadonlyArray<Case>;
    readonly switchRounds: number;
    readonly longTurns: number;
    readonly soak: number;
  },
) {
  const minified = yield* isMinified(checkout).pipe(Effect.orElseSucceed(() => null));
  return {
    minified,
    renders: workload.renders,
    cases: workload.cases.join(","),
    switchRounds: workload.switchRounds,
    longTurns: workload.longTurns,
    soak: workload.soak,
  };
});

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
      Option.getOrElse(input.checkout, () => path.resolve(import.meta.dirname, "../../..")),
    );
    const cases = yield* casesOf(input.cases);
    const meta = yield* metaFor(checkout);
    if (!input.skipBuild) yield* buildWeb(checkout, !input.unminified);
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
      renders: input.renders,
      slotNames: slotNamesOf(input.slotDiff),
      soak: input.soak,
      artifacts,
    });
    const metrics: ClientMetrics = {
      meta: {
        ...meta,
        ...(yield* measureMeta(checkout, { ...input, cases })),
        chromium: measured.chromium,
        loadAfter: yield* machineLoad,
      },
      runs: [measured.run],
      ...(measured.callSites ? { callSites: measured.callSites } : {}),
    };
    yield* writeMetrics(input.out, metrics);
    yield* Console.log(summaryTable(metrics));
  }),
).pipe(
  Command.withDescription(
    "Build a checkout's web app, seed a server with replayed threads, a large diff, a pull request on a fake GitHub and a local page, and measure thread switches, interactions, memory and renderer CPU in headless Chromium.",
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
    floors: floorsFlag,
  },
  Effect.fn("clientMetrics.ab")(function* (input) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outDir = path.resolve(input.outDir);
    yield* fs.makeDirectory(outDir, { recursive: true });
    const cases = yield* casesOf(input.cases);
    const floors = yield* readFloors(input.floors);
    const checkouts = [path.resolve(input.checkoutA), path.resolve(input.checkoutB)] as const;
    const metas = [yield* metaFor(checkouts[0]), yield* metaFor(checkouts[1])] as const;
    if (!input.skipBuild) {
      yield* buildWeb(checkouts[0], !input.unminified);
      // The same checkout twice (an A/A run) builds once.
      if (checkouts[1] !== checkouts[0]) yield* buildWeb(checkouts[1], !input.unminified);
    }
    const builds = [
      yield* measureMeta(checkouts[0], { ...input, cases }),
      yield* measureMeta(checkouts[1], { ...input, cases }),
    ] as const;
    const root = yield* workRoot;
    let chromiumVersion: string | null = null;
    const callSites: [ReadonlyArray<CallSite> | undefined, ReadonlyArray<CallSite> | undefined] = [
      undefined,
      undefined,
    ];
    const keepArtifacts = input.trace || input.renders;
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
          renders: input.renders,
          slotNames: slotNamesOf(input.slotDiff),
          soak: input.soak,
          artifacts: keepArtifacts
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
          meta: {
            ...metas[side],
            ...builds[side],
            chromium: chromiumVersion,
            loadAfter: yield* machineLoad,
          },
          runs: [...runs],
          ...(sideCallSites ? { callSites: sideCallSites } : {}),
        };
        yield* writeMetrics(Option.some(path.join(outDir, side === 0 ? "a.json" : "b.json")), file);
        return file;
      }),
    });
    yield* report(saved[0], saved[1], input.threshold, floors);
  }),
).pipe(
  Command.withDescription(
    "Run two checkouts alternately (A B, then B A) on this machine and compare them. The harness, seed and replay agent come from this script, so an older checkout works too; a case it cannot run is skipped and named.",
  ),
);

const readMetrics = Effect.fn("clientMetrics.readMetrics")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(Effect.flatMap(decodeMetrics));
});

const compareCommand = Command.make(
  "compare",
  {
    before: Argument.String("before").pipe(Argument.withDescription("Baseline JSON.")),
    after: Argument.String("after").pipe(Argument.withDescription("Candidate JSON.")),
    threshold: thresholdFlag,
    floors: floorsFlag,
  },
  Effect.fn("clientMetrics.compare")(function* (input) {
    const floors = yield* readFloors(input.floors);
    yield* report(
      yield* readMetrics(input.before),
      yield* readMetrics(input.after),
      input.threshold,
      floors,
    );
  }),
).pipe(
  Command.withDescription(
    "Markdown table of two result files, lower is better. Each run's median is one sample; with 2+ runs a side, a metric counts only when the 95% bootstrap interval of the median difference across runs clears the threshold and its floor (calibrated with --floors, else a default). One run a side is shown, not gated. Exits 1 on a regression.",
  ),
);

const noiseCommand = Command.make(
  "noise",
  {
    dirs: Argument.String("dir").pipe(
      Argument.withDescription(
        "An `ab` out dir (a.json and b.json) of one checkout against itself.",
      ),
      Argument.atLeast(1),
    ),
    out: Flag.String("out").pipe(
      Flag.withDescription("Floors file to write, for `compare --floors` and `ab --floors`."),
      Flag.optional,
    ),
  },
  Effect.fn("clientMetrics.noise")(function* (input) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const pairs = yield* Effect.forEach(input.dirs, (dir) =>
      Effect.gen(function* () {
        const a = yield* readMetrics(path.join(dir, "a.json"));
        const b = yield* readMetrics(path.join(dir, "b.json"));
        if (a.meta.commit === null || a.meta.commit !== b.meta.commit) {
          return yield* new MetricsError({
            message: `${dir}: a.json is ${a.meta.commit} and b.json ${b.meta.commit}; floors need one commit against itself`,
          });
        }
        // A probe or build difference would pass for noise and widen every floor.
        const settings = workloadDifferences(a, b, [...WORKLOAD_KEYS, ...PROBE_KEYS]).differ;
        if (settings.length > 0) {
          return yield* new MetricsError({
            message: `${dir}: a.json and b.json ran with different settings (${settings.join("; ")})`,
          });
        }
        for (const [file, metrics] of [
          ["a.json", a],
          ["b.json", b],
        ] as const) {
          for (const warning of loadWarnings(path.join(dir, file), metrics)) {
            yield* Console.error(`Warning: ${warning}`);
          }
        }
        return [a, b] as const;
      }),
    );
    const platforms = [...new Set(pairs.flat().map((file) => String(file.meta.platform)))];
    if (platforms.length !== 1) {
      return yield* new MetricsError({
        message: `the pairs ran on ${platforms.join(" and ")}; calibrate one platform at a time`,
      });
    }
    const { rows, floors, table } = noiseReport(pairs, platforms[0]!);
    if (rows.length === 0) {
      return yield* new MetricsError({ message: "no metric was measured on both sides" });
    }
    yield* Console.log(table);
    if (Option.isSome(input.out)) {
      yield* fs.writeFileString(input.out.value, `${yield* encodeFloors(floors)}\n`);
      yield* Console.error(`wrote ${input.out.value}`);
    }
  }),
).pipe(
  Command.withDescription(
    "Spread of every metric over A/A runs (`ab <same> <same>`): the 95% interval of the median difference, a calibrated floor covering it, and whether the metric is steady enough to gate on. ⚠ marks a floor above the default. --out writes the floors for compare.",
  ),
);

const summaryCommand = Command.make(
  "summary",
  { file: Argument.String("file").pipe(Argument.withDescription("A result JSON.")) },
  Effect.fn("clientMetrics.summary")(function* (input) {
    yield* Console.log(summaryTable(yield* readMetrics(input.file)));
  }),
).pipe(Command.withDescription("Print a result file's tables."));

const clientMetricsCommand = Command.make("client-metrics").pipe(
  Command.withDescription(
    `Measure the web client in headless Chromium against a production build and a seeded server. Linux and macOS.

Thread switches (each its own thread, switched to from a small hub thread by a sidebar click):
  short, long     Panel closed; one turn, and many heavy turns: the timeline's cost.
  working         A thread streaming a long replayed turn while it is switched to.
  approval        A thread waiting on an approval.
  medium          Panel closed, the same timeline as the panel cases: their baseline.
  diff            Diff panel on a branch changing 40 files.
  pull-request    Pull request panel with a long body, files, commits and comments (fake GitHub).
  browser         Browser surface on a local page.
  device          Device surface; no device stream exists here, so it shows its empty state (light).

Interactions (each a few measured steps inside one thread):
  type-short, type-long   Keys typed into the composer, each key to its next paint.
  scroll-long             Wheel up a fixed distance through the long timeline: missed frames, LoAF.
  palette                 Open the command palette, type a query.
  pr-tabs                 Pull request panel: Timeline, Code, then Summary.
  surfaces                Switch between two right-panel surfaces (pull request and diff).
  terminal                Open and close the terminal drawer.
  settings                Open Settings and go back.

Trust a change only from \`ab\` on one machine; calibrate floors with \`noise\` on A/A runs.`,
  ),
  Command.withSubcommands([runCommand, abCommand, compareCommand, noiseCommand, summaryCommand]),
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
