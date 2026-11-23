#!/usr/bin/env node
// Measures a checkout's server process (CPU, wakeups, memory, time to the API) against a fake
// Anthropic API and the real `claude` CLI. See docs/internals/performance-regressions.md.
// @effect-diagnostics nodeBuiltinImport:off - NodeHttpServer takes a node:http server.
import * as NodeHttp from "node:http";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/cli";
import { HttpClient, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Socket from "effect/socket/Socket";

import { run } from "./scenarios/shell.ts";
import {
  compareMetrics,
  CpuProfile,
  HeapProfile,
  HeapSnapshot,
  heapByConstructor,
  heapGrowth,
  round,
  ServerMetrics,
  slope,
  spread,
  parsePsCpuTime,
  parseRunSelection,
  summarizeProfiles,
  type FirstWord,
  type Measured,
  type ProfileSummary,
  type Window,
} from "./server-metrics-report.ts";

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const MODEL = "claude-haiku-4-5";
const SLOW_MARKER = "[[stream-slowly]]";

export class MetricsError extends Schema.TaggedError<MetricsError>()("MetricsError", {
  message: Schema.String,
}) {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
const encodeMetrics = Schema.encodeEffect(fromJsonStringPretty(ServerMetrics));

/** What a command printed, or none when it is missing or failed. */
const output = (program: string, args: ReadonlyArray<string>, cwd?: string) =>
  run(program, args, cwd === undefined ? {} : { cwd }).pipe(
    Effect.map(({ stdout }) => stdout.trim()),
    Effect.option,
  );
const powershell = (script: string) =>
  output("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);

/** Milliseconds on a monotonic clock, for intervals only. */
const nowMs = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos) / 1e6);

const httpServerOn = (port: number) =>
  NodeHttpServer.layer(() => NodeHttp.createServer(), { port, host: "127.0.0.1" });

interface ApiRequest {
  readonly at: number;
  readonly agent: boolean;
  readonly stream: boolean;
  readonly marker: string | undefined;
}

const MessagesRequest = Schema.Struct({
  stream: Schema.optional(Schema.Boolean),
  model: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
});

/** Streams a canned reply to every Messages request; a prompt holding SLOW_MARKER streams slowly. */
const serveFakeAnthropic = Effect.fn("serverMetrics.serveFakeAnthropic")(function* () {
  const requests: ApiRequest[] = [];
  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.url.includes("count_tokens")) {
      return HttpServerResponse.jsonUnsafe({ input_tokens: 100 });
    }
    if (!request.url.startsWith("/v1/messages")) {
      return HttpServerResponse.jsonUnsafe(
        { type: "error", error: { type: "not_found_error" } },
        { status: 404 },
      );
    }
    const raw = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
    const body = yield* decodeJson(MessagesRequest)(raw).pipe(
      Effect.orElseSucceed((): typeof MessagesRequest.Type => ({})),
    );
    const streamed = body.stream === true;
    requests.push({
      at: yield* nowMs,
      stream: streamed,
      // Title and branch-name jobs carry only their structured-output tool; the agent carries many.
      agent: streamed && (body.tools?.length ?? 0) > 1,
      marker: /bench-run-(\d+)/.exec(raw)?.[0],
    });
    const model = body.model ?? MODEL;
    const id = `msg_bench_${requests.length}`;
    if (!streamed) {
      return HttpServerResponse.jsonUnsafe({
        id,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: "Bench reply" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 },
      });
    }
    const event = (name: string, data: object) =>
      `event: ${name}\ndata: ${encodeJson({ type: name, ...data })}\n\n`;
    const slow = raw.includes(SLOW_MARKER);
    const words = slow ? 2_000 : 40;
    const deltas = Stream.range(0, words - 1).pipe(
      Stream.mapEffect((word) =>
        Effect.sleep(Duration.millis(slow ? 50 : 5)).pipe(
          Effect.as(
            event("content_block_delta", {
              index: 0,
              delta: { type: "text_delta", text: `${word ? " " : ""}word${word}` },
            }),
          ),
        ),
      ),
    );
    const events = Stream.make(
      event("message_start", {
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      }),
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    ).pipe(
      Stream.concat(deltas),
      Stream.concat(
        Stream.make(
          event("content_block_stop", { index: 0 }),
          event("message_delta", {
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: words },
          }),
          event("message_stop", {}),
        ),
      ),
      Stream.encodeText,
    );
    return HttpServerResponse.stream(events, {
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
    });
  });
  // Each run gets its own listener, closed with the run's scope.
  const context = yield* Layer.build(httpServerOn(0));
  return yield* Effect.gen(function* () {
    yield* HttpServer.serveEffect(Effect.interruptible(app));
    const { address } = yield* HttpServer.HttpServer;
    if (address._tag === "UnixPathAddress") {
      return yield* new MetricsError({ message: "the fake API has no TCP address" });
    }
    return { port: address.port, requests };
  }).pipe(Effect.provide(context));
});

/** A Chrome DevTools Protocol session on the server's inspector. */
const inspect = Effect.fn("serverMetrics.inspect")(function* (url: string) {
  const socket = yield* Socket.makeWebSocket(url);
  const reader = yield* socket.reader;
  const writer = yield* socket.writer;
  const pending = new Map<
    number,
    { method: string; answer: Deferred.Deferred<unknown, MetricsError> }
  >();
  const chunks: string[] = [];
  let nextId = 0;
  let closed = false;
  const decodeMessage = decodeJson(
    Schema.Struct({
      id: Schema.optional(Schema.Number),
      result: Schema.optional(Schema.Unknown),
      error: Schema.optional(Schema.Struct({ message: Schema.String })),
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Struct({ chunk: Schema.optional(Schema.String) })),
    }),
  );
  const text = new TextDecoder();
  yield* reader.pull.pipe(
    Effect.flatMap((frames) =>
      Effect.forEach(frames, (frame) =>
        decodeMessage(typeof frame === "string" ? frame : text.decode(frame)).pipe(
          Effect.flatMap((message) => {
            if (message.id !== undefined) {
              const waiting = pending.get(message.id);
              pending.delete(message.id);
              if (!waiting) return Effect.void;
              return message.error
                ? Deferred.fail(
                    waiting.answer,
                    new MetricsError({ message: `${waiting.method}: ${message.error.message}` }),
                  )
                : Deferred.succeed(waiting.answer, message.result);
            }
            if (message.method === "HeapProfiler.addHeapSnapshotChunk") {
              chunks.push(message.params?.chunk ?? "");
            }
            return Effect.void;
          }),
          Effect.ignore,
        ),
      ),
    ),
    Effect.forever,
    Effect.ignore,
    // A closed connection answers nothing, so every waiting call fails instead of hanging.
    Effect.ensuring(
      Effect.suspend(() => {
        closed = true;
        const waiting = [...pending.values()];
        pending.clear();
        return Effect.forEach(waiting, ({ method, answer }) =>
          Deferred.fail(answer, new MetricsError({ message: `${method}: the inspector closed` })),
        );
      }),
    ),
    Effect.forkScoped,
  );
  const send = Effect.fn("serverMetrics.cdp")(function* (method: string, params: object = {}) {
    if (closed) return yield* new MetricsError({ message: `${method}: the inspector closed` });
    const id = ++nextId;
    const answer = yield* Deferred.make<unknown, MetricsError>();
    pending.set(id, { method, answer });
    yield* writer.write(encodeJson({ id, method, params }));
    return yield* Deferred.await(answer);
  });
  const decodeHeapUsage = Schema.decodeUnknownEffect(Schema.Struct({ usedSize: Schema.Number }));
  const decodeEvaluated = Schema.decodeUnknownEffect(
    Schema.Struct({ result: Schema.Struct({ value: Schema.Number }) }),
  );
  const decodeHeapProfile = Schema.decodeUnknownEffect(Schema.Struct({ profile: HeapProfile }));
  const decodeCpuProfile = Schema.decodeUnknownEffect(Schema.Struct({ profile: CpuProfile }));
  return {
    // getrusage keeps the switches of threads that already exited, unlike per-thread counters.
    contextSwitches: send("Runtime.evaluate", {
      expression:
        "(() => { const u = process.resourceUsage(); return u.voluntaryContextSwitches + u.involuntaryContextSwitches; })()",
      returnByValue: true,
    }).pipe(
      Effect.flatMap(decodeEvaluated),
      Effect.map(({ result }) => result.value),
    ),
    heapAfterGc: Effect.gen(function* () {
      yield* send("HeapProfiler.collectGarbage");
      yield* send("HeapProfiler.collectGarbage");
      return (yield* decodeHeapUsage(yield* send("Runtime.getHeapUsage"))).usedSize;
    }),
    profile: Effect.fn("serverMetrics.profile")(function* (seconds: number) {
      yield* send("Profiler.enable");
      yield* send("Profiler.setSamplingInterval", { interval: 1_000 });
      yield* send("Profiler.start");
      yield* send("HeapProfiler.startSampling", {
        samplingInterval: 32_768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      yield* Effect.sleep(Duration.seconds(seconds));
      const heap = yield* send("HeapProfiler.stopSampling");
      const cpu = yield* send("Profiler.stop");
      yield* send("Profiler.disable");
      return {
        summary: summarizeProfiles(
          (yield* decodeCpuProfile(cpu)).profile,
          (yield* decodeHeapProfile(heap)).profile,
        ),
        raw: { cpu, heap },
      };
    }),
    snapshot: Effect.gen(function* () {
      chunks.length = 0;
      yield* send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
      const json = chunks.join("");
      chunks.length = 0;
      return heapByConstructor(yield* decodeJson(HeapSnapshot)(json));
    }),
  };
});

/** CPU seconds and RSS bytes of one process; a failed or unreadable probe fails the window. */
const sample = Effect.fn("serverMetrics.sample")(function* (pid: number) {
  const platform = yield* HostProcess.Platform;
  const checked = (cpuSeconds: number, rss: number, probe: string) =>
    Number.isFinite(cpuSeconds) && Number.isFinite(rss)
      ? Effect.succeed({ cpuSeconds, rss })
      : Effect.fail(new MetricsError({ message: `could not read process ${pid}: ${probe}` }));
  if (platform === "linux") {
    const fs = yield* FileSystem.FileSystem;
    const stat = (yield* fs.readFileString(`/proc/${pid}/stat`)).split(") ")[1]?.split(" ") ?? [];
    const status = yield* fs.readFileString(`/proc/${pid}/status`);
    const rss = /VmRSS:\s+(\d+)/.exec(status)?.[1];
    return yield* checked(
      (Number(stat[11]) + Number(stat[12])) / 100,
      rss === undefined ? Number.NaN : Number(rss) * 1024,
      "/proc",
    );
  }
  if (platform === "win32") {
    const line = yield* powershell(
      `$p = Get-Process -Id ${pid}; "$($p.TotalProcessorTime.TotalSeconds) $($p.WorkingSet64)"`,
    );
    const [cpu = "", rss = ""] = Option.getOrElse(line, () => "").split(/\s+/);
    return yield* checked(
      cpu ? Number(cpu) : Number.NaN,
      rss ? Number(rss) : Number.NaN,
      "Get-Process",
    );
  }
  const line = yield* output("ps", ["-o", "rss=,time=", "-p", `${pid}`]);
  const [rss = "", time = ""] = Option.getOrElse(line, () => "")
    .split(/\s+/)
    .filter(Boolean);
  return yield* checked(parsePsCpuTime(time), rss ? Number(rss) * 1024 : Number.NaN, "ps");
});

/** Every process below `pid`. Windows needs none: taskkill /T stops the tree. */
const descendantsOf = Effect.fn("serverMetrics.descendantsOf")(function* (pid: number) {
  const platform = yield* HostProcess.Platform;
  const children = new Map<number, number[]>();
  const add = (child: number, parent: number) =>
    children.set(parent, [...(children.get(parent) ?? []), child]);
  if (platform === "linux") {
    const fs = yield* FileSystem.FileSystem;
    for (const entry of yield* fs.readDirectory("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const stat = yield* fs
        .readFileString(`/proc/${entry}/stat`)
        .pipe(Effect.orElseSucceed(() => ""));
      const parent = Number(stat.split(") ")[1]?.split(" ")[1]);
      if (parent) add(Number(entry), parent);
    }
  } else if (platform === "darwin") {
    const table = yield* output("ps", ["-A", "-o", "pid=,ppid="]);
    for (const line of Option.getOrElse(table, () => "").split("\n")) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (child && parent) add(child, parent);
    }
  } else return [];
  const found: number[] = [];
  const pending = [pid];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const child of children.get(next) ?? []) {
      found.push(child);
      pending.push(child);
    }
  }
  return found;
});

interface Environment {
  readonly home: string;
  readonly apiPort: number;
  readonly requests: ReadonlyArray<ApiRequest>;
  readonly noAgentScope: boolean;
  readonly serverDir: string;
}

/** A free loopback port: bind 0, read it, let it go. */
const freePort = Effect.scoped(
  Effect.gen(function* () {
    const context = yield* Layer.build(httpServerOn(0));
    const { address } = Context.get(context, HttpServer.HttpServer);
    return address._tag === "UnixPathAddress" ? 0 : address.port;
  }),
);

/** A fresh server with its own base dir and git project, stopped when the scope closes. */
const startServer = Effect.fn("serverMetrics.startServer")(function* (
  environment: Environment,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const http = yield* HttpClient.HttpClient;
  const platform = yield* HostProcess.Platform;
  const node = yield* HostProcess.ExecutablePath;
  const hostEnvironment = yield* HostProcess.Environment;
  const directory = yield* fs.makeTempDirectory({
    directory: environment.home,
    prefix: `${name}-`,
  });
  const project = path.join(directory, "project");
  yield* fs.makeDirectory(project);
  yield* fs.writeFileString(path.join(project, "README.md"), "# bench\n");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "."],
    ["-c", "user.email=bench@t3.codes", "-c", "user.name=bench", "commit", "-qm", "init"],
  ]) {
    yield* run("git", args, { cwd: project });
  }
  const baseDir = path.join(directory, "base");
  // Branch names come from Claude too, so a worktree launch's naming call reaches the fake API.
  yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
  yield* fs.writeFileString(
    path.join(baseDir, "userdata/settings.json"),
    encodeJson({ textGenerationModelSelection: { instanceId: "claudeAgent", model: MODEL } }),
  );
  const dropped = new Set([
    "ANTHROPIC_AUTH_TOKEN",
    "T3CODE_HOME",
    "CLAUDE_CONFIG_DIR",
    ...(environment.noAgentScope ? ["XDG_RUNTIME_DIR"] : []),
  ]);
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(hostEnvironment).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && !dropped.has(entry[0]),
      ),
    ),
    HOME: environment.home,
    USERPROFILE: environment.home,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${environment.apiPort}`,
    ANTHROPIC_API_KEY: "sk-bench",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    OTEL_SDK_DISABLED: "true",
    T3CODE_DEV_SEED: "0",
  };
  const port = yield* freePort;
  const started = yield* nowMs;
  const child = yield* spawner.spawn(
    ChildProcess.make(
      node,
      [
        "--inspect=127.0.0.1:0",
        "src/bin.ts",
        "serve",
        "--base-dir",
        baseDir,
        "--port",
        `${port}`,
        "--host",
        "127.0.0.1",
        project,
      ],
      {
        cwd: environment.serverDir,
        env,
        extendEnv: false,
        // A server that ignores SIGTERM still stops, so cleanup always reaches the temp dir.
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
      const spawned = yield* descendantsOf(pid).pipe(Effect.orElseSucceed(() => []));
      if (platform === "win32") yield* output("taskkill", ["/PID", `${pid}`, "/T", "/F"]);
      else
        yield* child
          .kill({ killSignal: "SIGTERM", forceKillAfter: Duration.seconds(10) })
          .pipe(Effect.timeout(Duration.seconds(15)), Effect.ignore);
      yield* child.exitCode.pipe(Effect.timeout(Duration.seconds(10)), Effect.ignore);
      if (spawned.length > 0) yield* output("kill", ["-9", ...spawned.map(String)]);
      // Windows keeps a file locked for a moment after its process exits.
      yield* fs
        .remove(directory, { recursive: true })
        .pipe(Effect.retry({ schedule: Schedule.spaced(Duration.millis(500)), times: 20 }));
    }).pipe(Effect.ignore),
  );

  const readyMs = yield* http.get(`http://127.0.0.1:${port}/`).pipe(
    Effect.timeout(Duration.seconds(1)),
    Effect.retry({ schedule: Schedule.spaced(Duration.millis(100)), times: 600 }),
    Effect.andThen(nowMs),
    Effect.map((now) => Math.round(now - started)),
    Effect.catch(() =>
      Effect.flatMap(
        Ref.get(stderr),
        (text) => new MetricsError({ message: `server never answered:\n${text}` }),
      ),
    ),
  );
  const inspectorUrl = /ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/.exec(yield* Ref.get(stderr))?.[0];
  if (!inspectorUrl) return yield* new MetricsError({ message: "no inspector URL on stderr" });
  const devtools = yield* inspect(inspectorUrl);

  const cli = (args: ReadonlyArray<string>) =>
    run(node, ["src/bin.ts", ...args, "--base-dir", baseDir], {
      cwd: environment.serverDir,
      env,
      allowExit: [0, 1, 2],
    });
  const added = yield* cli(["project", "add", project]);
  if (added.exitCode !== 0) {
    return yield* new MetricsError({
      message: `project add failed: ${added.stderr.trim() || added.stdout.trim()}`,
    });
  }

  // Spawning PowerShell for each sample costs a few hundred ms of the machine's CPU.
  const sampleEvery = Duration.millis(platform === "win32" ? 5_000 : 1_000);
  const measure = Effect.fn("serverMetrics.measure")(function* (seconds: number) {
    // Each counter is divided by the time between its own two reads; a CIM probe can take seconds.
    // Windows reports no context switches through getrusage, so wakeups are unknown there.
    const countSwitches = platform === "win32" ? Effect.succeed(null) : devtools.contextSwitches;
    // A probe can take seconds (CIM on Windows), so each read is timed at its midpoint.
    const timed = Effect.fn("serverMetrics.timedRead")(function* <A, E, R>(
      read: Effect.Effect<A, E, R>,
    ) {
      const before = yield* nowMs;
      const value = yield* read;
      return { value, at: (before + (yield* nowMs)) / 2 };
    });
    const firstSwitches = yield* timed(countSwitches);
    const firstSample = yield* timed(sample(pid));
    const first = firstSample.value;
    const start = firstSample.at;
    let rssPeak = first.rss;
    while ((yield* nowMs) - start < seconds * 1_000) {
      yield* Effect.sleep(sampleEvery);
      rssPeak = Math.max(rssPeak, (yield* sample(pid)).rss);
    }
    const lastSample = yield* timed(sample(pid));
    const last = lastSample.value;
    const cpuElapsed = (lastSample.at - start) / 1_000;
    const lastSwitches = yield* timed(countSwitches);
    const switchesElapsed = (lastSwitches.at - firstSwitches.at) / 1_000;
    const switches =
      firstSwitches.value === null || lastSwitches.value === null
        ? null
        : lastSwitches.value - firstSwitches.value;
    const heap = yield* devtools.heapAfterGc;
    const window: Window = {
      cpuPct: round(((last.cpuSeconds - first.cpuSeconds) / cpuElapsed) * 100),
      wakeupsPerSec: switches === null ? null : round(switches / switchesElapsed),
      rssPeakMB: Math.round(Math.max(rssPeak, last.rss) / 1e6),
      rssMB: Math.round((yield* sample(pid)).rss / 1e6),
      heapAfterGcMB: round(heap / 1e6),
    };
    return window;
  });

  return {
    readyMs,
    measure,
    profile: devtools.profile,
    snapshot: devtools.snapshot,
    threadStart: (message: string, extra: ReadonlyArray<string> = []) =>
      cli([
        "thread",
        "start",
        "--provider",
        "claudeAgent",
        "--model",
        MODEL,
        ...extra,
        project,
        message,
      ]),
    threadSend: (threadId: string, message: string) =>
      cli(["thread", "send", "--wait", threadId, message]),
  };
});

type Server = Effect.Success<ReturnType<typeof startServer>>;

const firstWord = Effect.fn("serverMetrics.firstWord")(function* (
  environment: Environment,
  server: Server,
  runs: number,
  worktree: boolean,
) {
  const toRequest: number[] = [];
  const toDone: number[] = [];
  for (let index = 0; index < runs; index++) {
    const marker = `bench-run-${worktree ? 1000 + index : index}`;
    const started = yield* nowMs;
    const result = yield* server.threadStart(`Say hello. ${marker}`, [
      "--wait",
      ...(worktree ? ["--worktree", "main"] : []),
    ]);
    const done = (yield* nowMs) - started;
    if (result.exitCode !== 0) {
      return yield* new MetricsError({
        message: `thread start failed: ${result.stderr.trim() || result.stdout.trim()}`,
      });
    }
    const request = environment.requests.find(
      (entry) => entry.agent && entry.marker === marker && entry.at >= started,
    );
    if (!request) {
      return yield* new MetricsError({ message: `the agent request for ${marker} never arrived` });
    }
    toRequest.push(request.at - started);
    toDone.push(done);
  }
  const result: FirstWord = { toRequestMs: spread(toRequest), toDoneMs: spread(toDone) };
  return result;
});

/** Starts threads that each answer once, and returns their ids. */
const openThreads = Effect.fn("serverMetrics.openThreads")(function* (
  server: Server,
  from: number,
  count: number,
) {
  const answers = yield* Effect.forEach(
    Array.from({ length: count }, (_, index) => from + index),
    (index) => server.threadStart(`Say hello ${index}.`, ["--wait"]),
    { concurrency: "unbounded" },
  );
  const failed = answers.find((answer) => answer.exitCode !== 0);
  if (failed) {
    return yield* new MetricsError({
      message: `a thread failed to answer: ${failed.stderr.trim() || failed.stdout.trim()}`,
    });
  }
  // Without --json, `thread start` prints the new thread's id to stderr, older releases too.
  const ids = answers.map((answer) => /^Thread (\S+)$/m.exec(answer.stderr)?.[1]);
  if (ids.some((id) => id === undefined)) {
    return yield* new MetricsError({ message: "thread start printed no thread id" });
  }
  return ids.filter((id) => id !== undefined);
});

const SCENARIOS = ["startup", "rest", "firstWord", "quiet", "streaming"] as const;

interface RunOptions {
  readonly checkout: string;
  readonly noAgentScope: boolean;
  readonly runs: number;
  readonly threads: ReadonlyArray<number>;
  readonly only: ReadonlyArray<string>;
  readonly soakMinutes: number;
  /** Where full CPU and allocation profiles go; none are written without it. */
  readonly profileDir: string | undefined;
}

/** One pass: startup, rest and firstWord share a server; quiet, streaming and soak get their own. */
const runOnce = Effect.fn("serverMetrics.runOnce")(function* (options: RunOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-server-metrics-" });
  const api = yield* serveFakeAnthropic();
  const environment: Environment = {
    home,
    apiPort: api.port,
    requests: api.requests,
    noAgentScope: options.noAgentScope,
    serverDir: path.join(options.checkout, "apps/server"),
  };
  const wanted = (scenario: string) => options.only.length === 0 || options.only.includes(scenario);
  const measured: { -readonly [K in keyof Measured]: Measured[K] } = {};
  const profiles: Record<string, ProfileSummary> = {};
  let soakHeapGrowth: ReturnType<typeof heapGrowth> | undefined;
  const withServer = <A, E, R>(name: string, body: (server: Server) => Effect.Effect<A, E, R>) =>
    Effect.scoped(Effect.flatMap(startServer(environment, name), body));
  const profile = Effect.fn("serverMetrics.saveProfile")(function* (server: Server, name: string) {
    const { summary, raw } = yield* server.profile(20);
    profiles[name] = summary;
    if (options.profileDir === undefined) return;
    yield* fs.makeDirectory(options.profileDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(options.profileDir, `${name}.cpuprofile`),
      encodeJson(raw.cpu),
    );
    yield* fs.writeFileString(
      path.join(options.profileDir, `${name}.heapprofile`),
      encodeJson(raw.heap),
    );
  });

  if (wanted("startup") || wanted("rest") || wanted("firstWord")) {
    yield* withServer("rest", (server) =>
      Effect.gen(function* () {
        measured.startup = { readyMs: server.readyMs };
        if (wanted("rest")) {
          yield* Effect.sleep(Duration.seconds(15));
          measured.rest = yield* server.measure(30);
        }
        if (wanted("firstWord")) {
          measured.firstWord = {
            inPlace: yield* firstWord(environment, server, options.runs, false),
            worktree: yield* firstWord(environment, server, options.runs, true),
          };
        }
      }),
    );
  }
  if (wanted("quiet")) {
    yield* withServer("quiet", (server) =>
      Effect.gen(function* () {
        const points: Array<{ threads: number; window: Window }> = [];
        let open = 0;
        for (const threads of options.threads) {
          if (threads > open) yield* openThreads(server, open, threads - open);
          open = Math.max(open, threads);
          yield* Effect.sleep(Duration.seconds(15));
          points.push({ threads, window: yield* server.measure(30) });
        }
        const last = points.at(-1);
        if (last) measured.quiet = last.window;
        // The first thread also loads the provider's modules once, so the fit leaves out 0 threads.
        const withThreads = points.filter(({ threads }) => threads > 0);
        const fitted = withThreads.length >= 2 ? withThreads : points;
        const fit = (pick: (window: Window) => number) =>
          round(slope(fitted.map(({ threads, window }) => [threads, pick(window)])), 3);
        measured.scaling = {
          heapMBPerThread: fit((window) => window.heapAfterGcMB),
          rssMBPerThread: fit((window) => window.rssMB),
          cpuPctPerThread: fit((window) => window.cpuPct),
          wakeupsPerThread: points.every(({ window }) => window.wakeupsPerSec !== null)
            ? fit((window) => window.wakeupsPerSec ?? 0)
            : null,
          points: points.map(({ threads, window }) => [
            threads,
            window.cpuPct,
            window.wakeupsPerSec,
            window.rssMB,
            window.heapAfterGcMB,
          ]),
        };
        yield* profile(server, "quiet");
      }),
    );
  }
  if (wanted("streaming")) {
    yield* withServer("streaming", (server) =>
      Effect.gen(function* () {
        // Earlier scenarios share the fake API, so only this launch's requests count.
        const markers = [0, 1, 2, 3, 4].map((index) => `bench-run-${9_000 + index}`);
        const launchedAt = yield* nowMs;
        const started = yield* Effect.forEach(
          markers,
          (marker) => server.threadStart(`Write a long answer. ${SLOW_MARKER} ${marker}`),
          { concurrency: "unbounded" },
        );
        if (started.some((answer) => answer.exitCode !== 0)) {
          return yield* new MetricsError({ message: "streaming start failed" });
        }
        const streaming = () =>
          new Set(
            api.requests
              .filter((request) => request.agent && request.stream && request.at >= launchedAt)
              .map((request) => request.marker),
          );
        for (let attempt = 0; attempt < 300; attempt++) {
          if (markers.every((marker) => streaming().has(marker))) break;
          yield* Effect.sleep(Duration.millis(100));
        }
        if (!markers.every((marker) => streaming().has(marker))) {
          return yield* new MetricsError({ message: "fewer than 5 replies started streaming" });
        }
        yield* Effect.sleep(Duration.seconds(5));
        measured.streaming = yield* server.measure(60);
        yield* profile(server, "streaming");
      }),
    );
  }
  if (options.soakMinutes > 0) {
    yield* withServer("soak", (server) =>
      Effect.gen(function* () {
        const threads = yield* openThreads(server, 0, 10);
        yield* Effect.sleep(Duration.seconds(60));
        // The snapshot inflates RSS once, so the slopes start after it.
        const before = yield* server.snapshot;
        const samples: Array<{ hours: number; window: Window }> = [];
        const start = yield* nowMs;
        const elapsed = Effect.map(nowMs, (now) => now - start);
        const takeSample = Effect.gen(function* () {
          samples.push({ hours: (yield* elapsed) / 3_600_000, window: yield* server.measure(5) });
        });
        let nextSample = 0;
        for (let turn = 0; (yield* elapsed) < options.soakMinutes * 60_000; turn++) {
          if ((yield* elapsed) >= nextSample) {
            yield* takeSample;
            nextSample += 120_000;
          }
          const threadId =
            threads[yield* Random.nextIntBetween(0, threads.length, { halfOpen: true })];
          if (threadId === undefined)
            return yield* new MetricsError({ message: "no soak threads" });
          const sent = yield* server.threadSend(threadId, `Short reply ${turn}.`);
          if (sent.exitCode !== 0) {
            return yield* new MetricsError({
              message: `soak turn ${turn} on ${threadId} failed: ${sent.stderr.trim() || sent.stdout.trim()}`,
            });
          }
          yield* Effect.sleep(Duration.millis(Math.max(0, (turn + 1) * 30_000 - (yield* elapsed))));
        }
        yield* takeSample;
        const perHour = (pick: (window: Window) => number) =>
          round(slope(samples.map(({ hours, window }) => [hours, pick(window)])));
        measured.soak = {
          minutes: options.soakMinutes,
          heapMBPerHour: perHour((window) => window.heapAfterGcMB),
          rssMBPerHour: perHour((window) => window.rssMB),
        };
        soakHeapGrowth = heapGrowth(before, yield* server.snapshot);
      }),
    );
  }
  return { measured: measured as Measured, profiles, soakHeapGrowth };
}, Effect.scoped);

const machineLoad = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform === "win32") {
    return yield* powershell(
      "(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average",
    );
  }
  if (platform === "linux") {
    const fs = yield* FileSystem.FileSystem;
    const load = yield* fs.readFileString("/proc/loadavg").pipe(Effect.option);
    return Option.map(load, (text) => text.split(" ").slice(0, 3).join(" "));
  }
  return yield* output("sysctl", ["-n", "vm.loadavg"]);
}).pipe(
  Effect.map((load) =>
    Option.getOrNull(Option.map(load, (text) => text.replace(/[{}]/g, "").trim())),
  ),
);

const metaFor = Effect.fn("serverMetrics.metaFor")(function* (options: RunOptions) {
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const node = yield* HostProcess.ExecutablePath;
  const claude = yield* output("claude", ["--version"]);
  if (Option.isNone(claude)) {
    return yield* new MetricsError({ message: "The real `claude` CLI must be on PATH." });
  }
  if (options.noAgentScope && platform !== "linux") {
    return yield* new MetricsError({
      message: "--no-agent-scope is Linux only; other platforms never have an agent scope.",
    });
  }
  const cpus =
    platform === "win32"
      ? Option.fromNullishOr(environment.NUMBER_OF_PROCESSORS)
      : yield* output("getconf", ["_NPROCESSORS_ONLN"]);
  return {
    platform: `${platform}-${architecture}`,
    cpus: Option.getOrNull(Option.map(cpus, Number)),
    node: Option.getOrNull(yield* output(node, ["--version"])),
    claude: claude.value,
    commit: Option.getOrNull(
      yield* output("git", ["rev-parse", "--short=12", "HEAD"], options.checkout),
    ),
    noAgentScope: options.noAgentScope,
    agentScope:
      platform === "linux" &&
      !options.noAgentScope &&
      !!environment.XDG_RUNTIME_DIR &&
      Option.isSome(yield* output("sh", ["-c", "command -v systemd-run"])),
    loadBefore: yield* machineLoad,
    measuredAt: DateTime.formatIso(yield* DateTime.now),
  };
});

const writeMetrics = Effect.fn("serverMetrics.writeMetrics")(function* (
  out: Option.Option<string>,
  metrics: ServerMetrics,
) {
  const fs = yield* FileSystem.FileSystem;
  const json = yield* encodeMetrics(metrics);
  if (Option.isSome(out)) yield* fs.writeFileString(out.value, `${json}\n`);
  else yield* Console.log(json);
});

/** Prints the comparison and sets exit code 1 when a metric got worse. */
const report = Effect.fn("serverMetrics.report")(function* (
  before: ServerMetrics,
  after: ServerMetrics,
  threshold: number,
) {
  const { table, regressed, improved, compared } = compareMetrics(before, after, threshold);
  yield* Console.log(table);
  if (compared === 0) {
    return yield* new MetricsError({
      message: "the two files share no metric, so nothing was compared",
    });
  }
  if (improved.length) yield* Console.error(`Better: ${improved.join(", ")}`);
  if (regressed.length === 0) return;
  yield* Console.error(`Worse: ${regressed.join(", ")}`);
  yield* Effect.sync(() => {
    process.exitCode = 1;
  });
});

const thresholdFlag = Flag.Int("threshold").pipe(
  Flag.withDescription("Percent a metric must move, past its noise floor, to count."),
  Flag.withDefault(10),
);
const runFlags = {
  noAgentScope: Flag.Boolean("no-agent-scope").pipe(
    Flag.withAlias("mac-path"),
    Flag.withDefault(false),
    Flag.withDescription(
      "Linux only: start the server without XDG_RUNTIME_DIR, so it takes the no-agent-scope path macOS and Windows always take.",
    ),
  ),
  runs: Flag.Int("runs").pipe(
    Flag.withSchema(PositiveInt),
    Flag.withDescription("firstWord runs in each variant."),
    Flag.withDefault(5),
  ),
  threads: Flag.String("threads").pipe(
    Flag.withDescription("Open thread counts the quiet scenario measures."),
    Flag.withDefault("0,5,10,20"),
  ),
  only: Flag.String("only").pipe(
    Flag.withDescription(`Scenarios to run, comma separated: ${SCENARIOS.join(", ")}.`),
    Flag.optional,
  ),
  soak: Flag.Int("soak").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    Flag.withDescription(
      "Minutes of soak: 10 threads, a short turn every 30 s; heap and RSS slopes per hour and the constructors that grew. Runs alone unless --only names more.",
    ),
    Flag.withDefault(0),
  ),
};
interface RunFlags {
  readonly noAgentScope: boolean;
  readonly runs: number;
  readonly threads: string;
  readonly only: Option.Option<string>;
  readonly soak: number;
}

const toRunOptions = Effect.fn("serverMetrics.toRunOptions")(function* (
  flags: RunFlags,
  checkout: string,
  profileDir: string | undefined,
) {
  const path = yield* Path.Path;
  const selection = parseRunSelection({
    only: Option.getOrElse(flags.only, () => ""),
    threads: flags.threads,
    soak: flags.soak,
    scenarios: SCENARIOS,
  });
  if ("error" in selection) return yield* new MetricsError({ message: selection.error });
  const { only, threads } = selection;
  const options: RunOptions = {
    checkout: path.resolve(checkout),
    noAgentScope: flags.noAgentScope,
    runs: flags.runs,
    threads,
    only,
    soakMinutes: flags.soak,
    profileDir,
  };
  return options;
});

const runCommand = Command.make(
  "run",
  {
    ...runFlags,
    out: Flag.String("out").pipe(Flag.withDescription("JSON file to write."), Flag.optional),
    checkout: Flag.String("checkout").pipe(
      Flag.withDescription("Checkout whose server to measure, with dependencies installed."),
      Flag.optional,
    ),
    repeat: Flag.Int("repeat").pipe(
      Flag.withSchema(PositiveInt),
      Flag.withDescription("Runs to record in one file."),
      Flag.withDefault(1),
    ),
  },
  Effect.fn("serverMetrics.run")(function* (input) {
    const path = yield* Path.Path;
    const checkout = Option.getOrElse(input.checkout, () =>
      path.resolve(import.meta.dirname, ".."),
    );
    const profileDir = Option.getOrUndefined(
      Option.map(input.out, (out) => `${out.replace(/\.json$/, "")}-profiles`),
    );
    if (input.repeat < 1)
      return yield* new MetricsError({ message: "--repeat must be at least 1" });
    const options = yield* toRunOptions(input, checkout, profileDir);
    const meta = yield* metaFor(options);
    const runs: Measured[] = [];
    let last: Effect.Success<ReturnType<typeof runOnce>> | undefined;
    for (let index = 0; index < input.repeat; index++) {
      last = yield* runOnce(options);
      runs.push(last.measured);
    }
    yield* writeMetrics(input.out, {
      meta: { ...meta, loadAfter: yield* machineLoad },
      runs,
      ...(last ? { profiles: last.profiles } : {}),
      ...(last?.soakHeapGrowth ? { soakHeapGrowth: last.soakHeapGrowth } : {}),
    });
  }),
).pipe(
  Command.withDescription(
    "Measure a checkout's server: startup, rest and first word on one server, then quiet threads (with their cost per thread), streaming and an optional soak on servers of their own. Needs the real claude CLI on PATH; on Windows the native claude.exe from claude.ai/install.ps1, since an npm claude.cmd shim cannot be started without a shell.",
  ),
);

const abCommand = Command.make(
  "ab",
  {
    ...runFlags,
    checkoutA: Argument.String("checkout-a").pipe(Argument.withDescription("Baseline checkout.")),
    checkoutB: Argument.String("checkout-b").pipe(Argument.withDescription("Candidate checkout.")),
    rounds: Flag.Int("rounds").pipe(
      Flag.withSchema(PositiveInt),
      Flag.withDescription("Rounds; each runs A and B once, alternating which goes first."),
      Flag.withDefault(3),
    ),
    outDir: Flag.String("out-dir").pipe(
      Flag.withDescription("Directory for a.json and b.json."),
      Flag.withDefault("server-metrics-ab"),
    ),
    threshold: thresholdFlag,
  },
  Effect.fn("serverMetrics.ab")(function* (input) {
    if (input.rounds < 1)
      return yield* new MetricsError({ message: "--rounds must be at least 1" });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const outDir = path.resolve(input.outDir);
    yield* fs.makeDirectory(outDir, { recursive: true });
    const sides = [
      yield* toRunOptions(input, input.checkoutA, undefined),
      yield* toRunOptions(input, input.checkoutB, undefined),
    ] as const;
    const metas = [yield* metaFor(sides[0]), yield* metaFor(sides[1])] as const;
    const runs: [Measured[], Measured[]] = [[], []];
    for (let round = 0; round < input.rounds; round++) {
      // A B, then B A, so a drift in machine load lands on both sides.
      for (const side of round % 2 === 0 ? ([0, 1] as const) : ([1, 0] as const)) {
        yield* Console.error(`round ${round + 1}/${input.rounds}: ${side === 0 ? "A" : "B"}`);
        runs[side].push((yield* runOnce(sides[side])).measured);
      }
    }
    const loadAfter = yield* machineLoad;
    const before: ServerMetrics = { meta: { ...metas[0], loadAfter }, runs: runs[0] };
    const after: ServerMetrics = { meta: { ...metas[1], loadAfter }, runs: runs[1] };
    yield* writeMetrics(Option.some(path.join(outDir, "a.json")), before);
    yield* writeMetrics(Option.some(path.join(outDir, "b.json")), after);
    yield* report(before, after, input.threshold);
  }),
).pipe(
  Command.withDescription(
    "Run two checkouts alternately on this machine and compare them. Each needs its dependencies installed; the harness comes from this script, so an old release works too.",
  ),
);

const compareCommand = Command.make(
  "compare",
  {
    before: Argument.String("before").pipe(Argument.withDescription("Baseline JSON.")),
    after: Argument.String("after").pipe(Argument.withDescription("Candidate JSON.")),
    threshold: thresholdFlag,
  },
  Effect.fn("serverMetrics.compare")(function* (input) {
    const fs = yield* FileSystem.FileSystem;
    const read = (file: string) =>
      fs.readFileString(file).pipe(Effect.flatMap(decodeJson(ServerMetrics)));
    yield* report(yield* read(input.before), yield* read(input.after), input.threshold);
  }),
).pipe(
  Command.withDescription(
    "Markdown table of two result files, lower is better. With 2+ runs a side, a metric counts only when the 95% bootstrap interval of the median difference clears the threshold and its noise floor (1 CPU point, 20 wakeups/s, 15 MB, 300 ms; per thread 2 MB or 0.2 CPU points). Exits 1 on a regression.",
  ),
);

const serverMetricsCommand = Command.make("server-metrics").pipe(
  Command.withDescription(
    "Measure the server process against a fake Anthropic API and the real claude CLI, on Linux, macOS and Windows.",
  ),
  Command.withSubcommands([runCommand, abCommand, compareCommand]),
);

if (import.meta.main) {
  Command.run(serverMetricsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeHttpClient.layerUndici,
        NodeSocket.layerWebSocketConstructor,
      ),
    ),
    NodeRuntime.runMain,
  );
}
