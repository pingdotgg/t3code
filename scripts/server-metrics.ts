#!/usr/bin/env node
// Measures a checkout's server process (CPU, wakeups, memory, time to the API) against a fake
// Anthropic API and the real `claude` CLI. See docs/internals/16_performance-regressions.md.
// @effect-diagnostics nodeBuiltinImport:off - NodeHttpServer takes a node:http server.
import * as NodeHttp from "node:http";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/cli";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadStreamItem,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import {
  HttpClient,
  HttpClientRequest,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";

import { run } from "./scenarios/shell.ts";
import {
  compareMetrics,
  CpuProfile,
  describeFailure,
  HeapProfile,
  HeapSnapshot,
  heapByConstructor,
  heapGrowth,
  competingBetween,
  loadWarnings,
  noiseReport,
  noiseRulesFor,
  noisePairProblem,
  profileMismatch,
  round,
  ServerMetrics,
  slope,
  spread,
  activityRenewalMissed,
  nextActivityReport,
  parsePsCpuTime,
  pathRewrites,
  pathSpellings,
  parseRunSelection,
  summarizeProfiles,
  type FirstWord,
  type MachineState,
  type Measured,
  type WorkingPoint,
  type ProfileSummary,
  type Window,
} from "./server-metrics-report.ts";

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const MODEL = "claude-haiku-4-5";
const SLOW_MARKER = "[[stream-slowly]]";
/** A prompt holding this streams a reply that ends in a Write tool call, then a short answer. */
const EDIT_MARKER = "[[edit-files]]";
/**
 * How long each scenario measures. `quick` keeps every scenario but shortens its windows, for a
 * per-PR or nightly check; its numbers compare only with other quick runs.
 */
const PROFILES = {
  full: {
    /** Idle time before a quiet window, so startup and thread setup work has drained. */
    settleSeconds: 15,
    windowSeconds: 30,
    streamingSeconds: 60,
    profileSeconds: 20,
    /** Sequential turns in the pipeline scenario. */
    pipelineTurns: 50,
    /** Threads working at once in each window of the working scenario. */
    workingThreads: [5, 10, 20],
    workingWarmupSeconds: 10,
    /** Long enough that most threads finish a turn inside it even at 20 working. */
    workingSeconds: 30,
    threads: "0,5,10,20",
    runs: 5,
  },
  quick: {
    settleSeconds: 5,
    windowSeconds: 10,
    streamingSeconds: 20,
    profileSeconds: 5,
    pipelineTurns: 15,
    workingThreads: [5, 20],
    workingWarmupSeconds: 5,
    workingSeconds: 20,
    threads: "0,10",
    runs: 3,
  },
} as const;
type Profile = (typeof PROFILES)[keyof typeof PROFILES];
/** A user's devices: clients that drop and reconnect at once, each holding this many threads. */
const RECONNECT_CLIENTS = 3;
const RECONNECT_THREADS = 10;
/** Clients that drop and reconnect at once in the opt-in storm, each holding one thread. */
const STORM_CLIENTS = 20;
/** Event-loop delay sampling interval; each sample wakes the loop once. */
const LOOP_RESOLUTION_MS = 10;
const LoopStats = Schema.Struct({
  p50: Schema.Number,
  p99: Schema.Number,
  max: Schema.Number,
  samples: Schema.Number,
  gcCount: Schema.Number,
  gcMs: Schema.Number,
});

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
  /** The request carries a tool result, so it is a turn's follow-up rather than its start. */
  readonly toolResult: boolean;
  /** When the reply's last event was produced; streamed replies only. */
  endedAt?: number;
}

const MessagesRequest = Schema.Struct({
  stream: Schema.optional(Schema.Boolean),
  model: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
  messages: Schema.optional(
    Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
  ),
});

/** Whether the newest message hands back a tool's result. */
const endsInToolResult = (messages: typeof MessagesRequest.Type.messages) => {
  const content = messages?.at(-1)?.content;
  return (
    Array.isArray(content) &&
    content.some(
      (block: unknown) =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "tool_result",
    )
  );
};

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
    const toolResult = endsInToolResult(body.messages);
    const entry: ApiRequest = {
      toolResult,
      at: yield* nowMs,
      stream: streamed,
      // Title and branch-name jobs carry only their structured-output tool; the agent carries many.
      agent: streamed && (body.tools?.length ?? 0) > 1,
      // A follow-up carries the thread's earlier prompts too, so the newest marker is the turn's.
      marker: [...raw.matchAll(/bench-run-\d+/g)].at(-1)?.[0],
    };
    requests.push(entry);
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
    // An editing turn streams a longer first reply, then writes a file in the agent's directory.
    const cwd = /Primary working directory: ([^\\"\n]+)/.exec(raw)?.[1]?.trim();
    const edit = entry.agent && raw.includes(EDIT_MARKER) && !toolResult && cwd !== undefined;
    const words = slow ? 2_000 : edit ? 150 : 40;
    const deltas = Stream.range(0, words - 1).pipe(
      Stream.mapEffect((word) =>
        Effect.sleep(Duration.millis(slow ? 50 : edit ? 10 : 5)).pipe(
          Effect.as(
            event("content_block_delta", {
              index: 0,
              delta: { type: "text_delta", text: `${word ? " " : ""}word${word}` },
            }),
          ),
        ),
      ),
    );
    const toolCall = edit
      ? Stream.make(
          event("content_block_stop", { index: 0 }),
          event("content_block_start", {
            index: 1,
            content_block: {
              type: "tool_use",
              id: `toolu_bench_${requests.length}`,
              name: "Write",
              input: {},
            },
          }),
          event("content_block_delta", {
            index: 1,
            delta: {
              type: "input_json_delta",
              partial_json: encodeJson({
                file_path: `${cwd}/bench/${entry.marker ?? `turn-${requests.length}`}.md`,
                content: Array.from({ length: 40 }, (_, line) => `line ${line} of ${id}`).join(
                  "\n",
                ),
              }),
            },
          }),
          event("content_block_stop", { index: 1 }),
          event("message_delta", {
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: words },
          }),
        )
      : Stream.make(
          event("content_block_stop", { index: 0 }),
          event("message_delta", {
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: words },
          }),
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
      Stream.concat(toolCall),
      // Stamped as the last event is produced, so it is set before any client can see the end.
      Stream.concat(
        Stream.fromEffect(
          Effect.map(nowMs, (now) => {
            entry.endedAt = now;
            return event("message_stop", {});
          }),
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
  const decodeLoop = Schema.decodeUnknownEffect(
    Schema.Struct({ result: Schema.Struct({ value: Schema.fromJsonString(LoopStats) }) }),
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
    // One histogram and GC observer live in the server; a window resets them and reads them back.
    // Node delivers GC entries to observers from a later setImmediate, which takeRecords() cannot
    // reach, so each boundary first lets two turns pass and the pending entries land on its side.
    loopStart: send("Runtime.evaluate", {
      awaitPromise: true,
      expression: `(async () => {
        const bench = (globalThis.__t3ServerMetrics ??= (() => {
          const { monitorEventLoopDelay, PerformanceObserver } = process.getBuiltinModule("node:perf_hooks");
          const state = { delay: monitorEventLoopDelay({ resolution: ${LOOP_RESOLUTION_MS} }), gcCount: 0, gcMs: 0 };
          state.count = (entries) => {
            for (const entry of entries) { state.gcCount++; state.gcMs += entry.duration; }
          };
          state.gc = new PerformanceObserver((list) => state.count(list.getEntries()));
          state.gc.observe({ entryTypes: ["gc"] });
          return state;
        })());
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        bench.gc.takeRecords();
        bench.delay.reset();
        bench.delay.enable();
        bench.gcCount = 0;
        bench.gcMs = 0;
      })()`,
    }).pipe(Effect.asVoid),
    loopRead: send("Runtime.evaluate", {
      awaitPromise: true,
      expression: `(async () => {
        const bench = globalThis.__t3ServerMetrics;
        bench.delay.disable();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        bench.count(bench.gc.takeRecords());
        const ms = (ns) => Math.max(0, ns / 1e6 - ${LOOP_RESOLUTION_MS});
        return JSON.stringify({
          p50: ms(bench.delay.percentile(50)),
          p99: ms(bench.delay.percentile(99)),
          max: ms(bench.delay.max),
          samples: bench.delay.count,
          gcCount: bench.gcCount,
          gcMs: bench.gcMs,
        });
      })()`,
      returnByValue: true,
    }).pipe(
      Effect.flatMap(decodeLoop),
      Effect.map(({ result }) => result.value),
    ),
    // Off-heap and touched, so it adds RSS (and page tables to copy on fork) but no GC work.
    ballast: (mb: number) =>
      send("Runtime.evaluate", {
        expression: `globalThis.__t3ServerMetricsBallast = Array.from({ length: ${mb} }, () => new Uint8Array(1 << 20).fill(1)), 0`,
      }).pipe(Effect.asVoid),
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
  /** The checkout whose clones back a seeded server's projects. */
  readonly checkout: string;
}

interface ServerOptions {
  /** A base dir `migrate-dev-db` prepared; the server starts on a copy of its database. */
  readonly seed?: string;
}

/** Transcript text: paths there are words in a conversation, which the server never acts on. */
const TRANSCRIPT_TABLES = new Set([
  "orchestration_events",
  "orchestration_v2_events",
  "orchestration_v2_projection_messages",
  "orchestration_v2_projection_turn_items",
  "projection_thread_messages",
  "projection_thread_activities",
  "checkpoint_diff_blobs",
]);
const TRANSCRIPT_COLUMNS = new Set(["title", "text", "last_error"]);

/**
 * Copies a seeded database into `directory` and makes it safe to serve: every path under the
 * developer's home or a project root is moved under `directory/gone`, which does not exist, and
 * every project points at a clone of `checkout`, so git runs on real-size trees and never on the
 * developer's. Fails if a real path survives outside transcript text.
 */
const seedBaseDir = Effect.fn("serverMetrics.seedBaseDir")(function* (
  seed: string,
  baseDir: string,
  directory: string,
  checkout: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const database = path.join(baseDir, "userdata/statev2.sqlite");
  const reposDir = path.join(directory, "repos");
  const gone = path.join(directory, "gone");
  yield* fs.copyFile(path.join(seed, "userdata/statev2.sqlite"), database);
  // A seed made by an older checkout can still hold work startup would resume, so this checkout's
  // migrate-dev-db drops it from the copy and fails if any remains.
  const dropped = yield* run(
    yield* HostProcess.ExecutablePath,
    [
      path.join(import.meta.dirname, "../apps/server/scripts/migrate-dev-db.ts"),
      "--drop-resumable",
      database,
    ],
    { allowExit: [0, 1] },
  );
  if (dropped.exitCode !== 0) {
    return yield* new MetricsError({
      message: `refusing to start on the seed: ${dropped.stderr.trim() || dropped.stdout.trim()}`,
    });
  }
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projects = yield* sql<{ project_id: string; deleted: number; workspace_root: string }>`
      SELECT project_id, deleted_at IS NOT NULL AS deleted, workspace_root FROM projection_projects`;
    const home = environment.HOME ?? environment.USERPROFILE;
    const real = [
      ...new Set(
        [...(home ? [home] : []), ...projects.map((project) => project.workspace_root)].map(
          (prefix) => prefix.replace(/[\\/]+$/, ""),
        ),
      ),
    ].filter((prefix) => prefix.length > 1);
    // The run's own directory sits under home too, so it is taken out before a value is judged.
    const withoutRun = (column: string) =>
      pathSpellings(directory).reduce(
        (value, spelling) => sql`replace(${value}, ${spelling}, '')`,
        sql`CAST(${sql(column)} AS TEXT)`,
      );
    const mentionsReal = (column: string, prefix: string) =>
      sql.or(
        pathSpellings(prefix).map((spelling) => sql`instr(${withoutRun(column)}, ${spelling}) > 0`),
      );
    const columns: Array<{ table: string; column: string }> = [];
    for (const { name } of yield* sql<{ name: string; virtual: number }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'`) {
      if (TRANSCRIPT_TABLES.has(name) || name.startsWith("sqlite_") || name.includes("search")) {
        continue;
      }
      for (const column of yield* sql<{ name: string; type: string }>`
        SELECT name, type FROM pragma_table_info(${name})`) {
        if (/^(TEXT|)$/i.test(column.type) && !TRANSCRIPT_COLUMNS.has(column.name)) {
          columns.push({ table: name, column: column.name });
        }
      }
    }
    // Every occurrence, mid-string too: a prompt or preview inside state JSON can name a path.
    // Longer prefixes first, so a project root is not cut by the home prefix inside it.
    const longestFirst = real.toSorted((a, b) => b.length - a.length);
    // Every spelling, since JSON keeps a Windows path's backslashes doubled. Each goes to a marker
    // first: the destination sits under home too, and a later, shorter prefix would rewrite it.
    const rewrites = longestFirst.flatMap((prefix, index) =>
      pathRewrites(prefix, path.join(gone, `root-${index}`)).map(([from, to], spelling) => ({
        from,
        to,
        marker: `«t3-bench-gone-${index}-${spelling}»`,
      })),
    );
    for (const { table, column } of columns) {
      for (const [from, to] of [
        ...rewrites.map(({ from, marker }) => [from, marker] as const),
        ...rewrites.map(({ marker, to }) => [marker, to] as const),
      ]) {
        yield* sql`UPDATE ${sql(table)} SET ${sql(column)} = replace(${sql(column)}, ${from}, ${to})
          WHERE instr(${sql(column)}, ${from}) > 0`;
      }
    }
    const roots: string[] = [];
    yield* Effect.forEach(
      projects,
      (project, index) =>
        Effect.gen(function* () {
          const root = path.join(reposDir, `repo-${index}`);
          if (!project.deleted) {
            yield* run("git", ["clone", "--shared", "-q", checkout, root]);
            roots.push(root);
          }
          yield* sql`UPDATE projection_projects SET workspace_root = ${root}
            WHERE project_id = ${project.project_id}`;
        }),
      { concurrency: 4, discard: true },
    );
    yield* sql`UPDATE projection_projects SET tracked_folders_json = '[]', favicon_path = NULL`;
    yield* sql`UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.worktreePath', json('null'))
      WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL`;
    const tables = new Set(
      (yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`).map(
        (table) => table.name,
      ),
    );
    if (tables.has("projection_threads"))
      yield* sql`UPDATE projection_threads SET worktree_path = NULL`;
    // Durable workflows postdate migrate-dev-db's list of pending work, so none may resume here.
    for (const table of tables) {
      if (table === "task_folders" || table.startsWith("workflow_")) {
        yield* sql`DELETE FROM ${sql(table)}`;
      }
    }
    const named: string[] = [];
    for (const { table, column } of columns) {
      for (const prefix of real) {
        const [found] = yield* sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM ${sql(table)} WHERE ${mentionsReal(column, prefix)}`;
        if (Number(found?.n ?? 0) > 0) named.push(`${table}.${column}`);
      }
    }
    if (named.length > 0) {
      return yield* new MetricsError({
        message: `the seed still names real paths in ${[...new Set(named)].join(", ")}`,
      });
    }
    const [runs] = yield* sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM orchestration_v2_projection_runs`;
    const [largest] = yield* sql<{ thread_id: string; messages: number }>`
      SELECT thread_id, COUNT(*) AS messages FROM orchestration_v2_projection_messages
      GROUP BY thread_id ORDER BY messages DESC LIMIT 1`;
    return {
      roots,
      runs: Number(runs?.n ?? 0),
      largest: largest && { threadId: largest.thread_id, messages: Number(largest.messages) },
    };
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: database })));
});

/** Runs the checkout's own `migrate-dev-db` into a temp base dir, closed with the scope. */
const prepareSeed = Effect.fn("serverMetrics.prepareSeed")(function* (
  checkout: string,
  projects: number,
  threadsPerProject: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const node = yield* HostProcess.ExecutablePath;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-server-metrics-seed-" });
  yield* Console.error(`seeding ${checkout} from the real database (read-only)...`);
  // Its output names the kept projects, so it stays out of ours.
  const seeded = yield* run(
    node,
    [
      "apps/server/scripts/migrate-dev-db.ts",
      "--base-dir",
      dir,
      "--projects",
      `${projects}`,
      "--threads-per-project",
      `${threadsPerProject}`,
    ],
    { cwd: checkout, allowExit: [0, 1] },
  );
  if (seeded.exitCode !== 0) {
    return yield* new MetricsError({ message: `migrate-dev-db failed:\n${seeded.stderr.trim()}` });
  }
  return dir;
});

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
  options: ServerOptions = {},
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
  const seeded =
    options.seed === undefined
      ? undefined
      : yield* seedBaseDir(options.seed, baseDir, directory, environment.checkout);
  const roots = seeded?.roots ?? [];
  const largest = seeded?.largest;
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
    // A seeded database or a loaded machine can keep startup past a minute.
    Effect.retry({ schedule: Schedule.spaced(Duration.millis(100)), times: 3_000 }),
    Effect.andThen(nowMs),
    Effect.map((now) => Math.round(now - started)),
    Effect.catch(() =>
      Effect.flatMap(
        Ref.get(stderr),
        (text) => new MetricsError({ message: `server never answered:\n${text}` }),
      ),
    ),
  );
  // The server answers HTTP before it records its runtime state, and until then the CLI
  // finds no server, tries to make changes locally, and exits 78 on the server's lock.
  yield* fs.exists(path.join(baseDir, "userdata/server-runtime.json")).pipe(
    Effect.filterOrFail((recorded) => recorded),
    Effect.retry({ schedule: Schedule.spaced(Duration.millis(100)), times: 3_000 }),
    Effect.catch(() =>
      Effect.flatMap(
        Ref.get(stderr),
        (text) =>
          new MetricsError({ message: `server never recorded its runtime state:\n${text}` }),
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
    yield* devtools.loopStart;
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
    // Read before the forced GC below, which would count as a pause.
    const loop = yield* devtools.loopRead;
    const switchesElapsed = (lastSwitches.at - firstSwitches.at) / 1_000;
    const switches =
      firstSwitches.value === null || lastSwitches.value === null
        ? null
        : Math.max(0, lastSwitches.value - firstSwitches.value);
    const heap = yield* devtools.heapAfterGc;
    const window: Window = {
      cpuPct: round(((last.cpuSeconds - first.cpuSeconds) / cpuElapsed) * 100),
      wakeupsPerSec: switches === null ? null : round(switches / switchesElapsed),
      rssPeakMB: Math.round(Math.max(rssPeak, last.rss) / 1e6),
      rssMB: Math.round((yield* sample(pid)).rss / 1e6),
      heapAfterGcMB: round(heap / 1e6),
      loopDelayP50Ms: round(loop.p50),
      loopDelayP99Ms: round(loop.p99),
      loopDelayMaxMs: round(loop.max),
      loopSamples: loop.samples,
      gcCount: loop.gcCount,
      gcPauseMs: round(loop.gcMs),
    };
    return window;
  });

  return {
    readyMs,
    startedAt: started,
    origin: `http://127.0.0.1:${port}`,
    /** The seeded projects' clones; none without a seed. */
    roots,
    /**
     * Fails if the server started a run or called the agent API on its own since `since`: a seeded
     * server must never resume the developer's work.
     */
    assertIdle: Effect.fn("serverMetrics.assertIdle")(function* (since: number) {
      const called = environment.requests.some((request) => request.at >= since);
      const runs = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM orchestration_v2_projection_runs`;
        return Number(row?.n ?? 0);
      }).pipe(
        Effect.provide(
          NodeSqliteClient.layer({
            filename: path.join(baseDir, "userdata/statev2.sqlite"),
            readonly: true,
          }),
        ),
      );
      if (called || runs !== (seeded?.runs ?? runs)) {
        return yield* new MetricsError({
          message: `the seeded server started work on its own (${runs - (seeded?.runs ?? 0)} new runs, API ${called ? "called" : "idle"})`,
        });
      }
    }),
    /** The seeded thread with the most messages. */
    largest,
    measure,
    profile: devtools.profile,
    snapshot: devtools.snapshot,
    heapAfterGc: devtools.heapAfterGc,
    loopStart: devtools.loopStart,
    loopRead: devtools.loopRead,
    project,
    ballast: devtools.ballast,
    issueToken: cli(["auth", "session", "issue", "--token-only"]).pipe(
      Effect.map(({ stdout }) => stdout.trim()),
    ),
    threadStart: (message: string, extra: ReadonlyArray<string> = [], root = project) =>
      cli([
        "thread",
        "start",
        "--provider",
        "claudeAgent",
        "--model",
        MODEL,
        ...extra,
        root,
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

/** The shell snapshot the web and mobile clients load first, timed to its last byte. */
const loadShell = Effect.fn("serverMetrics.loadShell")(function* (server: Server, times: number) {
  const http = yield* HttpClient.HttpClient;
  const token = yield* server.issueToken;
  const request = HttpClientRequest.get(
    `${server.origin}/api/orchestration/shell?omitIdleSubagents=1&omitOlderSettled=1`,
  ).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.setHeader(ORCHESTRATION_PROTOCOL_HEADER, ORCHESTRATION_PROTOCOL_VERSION_TEXT),
  );
  const elapsed: number[] = [];
  let bytes = 0;
  for (let index = 0; index < times; index++) {
    const started = yield* nowMs;
    const response = yield* http.execute(request);
    const body = yield* response.arrayBuffer;
    if (response.status !== 200) {
      return yield* new MetricsError({ message: `shell snapshot answered ${response.status}` });
    }
    elapsed.push((yield* nowMs) - started);
    bytes = body.byteLength;
  }
  return { ms: spread(elapsed), KB: Math.round(bytes / 1_000) };
});

/** The bounded HTTP snapshot a client loads to open a thread, timed to its last byte. */
const loadThread = Effect.fn("serverMetrics.loadThread")(function* (
  server: Server,
  threadId: string,
  times: number,
) {
  const http = yield* HttpClient.HttpClient;
  const token = yield* server.issueToken;
  const request = HttpClientRequest.get(
    `${server.origin}/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded?compactTurnItems=1&dedupeBodies=1&compactIds=1&deferWork=1`,
  ).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.setHeader(ORCHESTRATION_PROTOCOL_HEADER, ORCHESTRATION_PROTOCOL_VERSION_TEXT),
  );
  const before = yield* server.heapAfterGc;
  const elapsed: number[] = [];
  let bytes = 0;
  for (let index = 0; index < times; index++) {
    const started = yield* nowMs;
    const response = yield* http.execute(request);
    const body = yield* response.arrayBuffer;
    if (response.status !== 200) {
      return yield* new MetricsError({ message: `thread snapshot answered ${response.status}` });
    }
    elapsed.push((yield* nowMs) - started);
    bytes = body.byteLength;
  }
  return {
    ms: spread(elapsed),
    KB: Math.round(bytes / 1_000),
    heapMB: round(((yield* server.heapAfterGc) - before) / 1e6),
  };
});

/** Short turns back to back in a clone, each ending in a checkpoint of the whole tree. */
const gitTraffic = Effect.fn("serverMetrics.gitTraffic")(function* (server: Server) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = server.roots[0];
  if (root === undefined) return yield* new MetricsError({ message: "the seed has no projects" });
  const touch = (turn: number) =>
    fs.writeFileString(path.join(root, "BENCH.md"), `turn ${turn}\n`, { flag: "a" });
  yield* touch(0);
  const started = yield* server.threadStart("Say hello.", ["--wait"], root);
  const threadId = /^Thread (\S+)$/m.exec(started.stderr)?.[1];
  if (started.exitCode !== 0 || threadId === undefined) {
    return yield* new MetricsError({
      message: `a turn in a clone failed: ${started.stderr.trim() || started.stdout.trim()}`,
    });
  }
  return Effect.gen(function* () {
    for (let turn = 1; ; turn++) {
      yield* touch(turn);
      const sent = yield* server.threadSend(threadId, `Short reply ${turn}.`);
      if (sent.exitCode !== 0) {
        return yield* new MetricsError({
          message: `git traffic turn ${turn} failed: ${sent.stderr.trim() || sent.stdout.trim()}`,
        });
      }
    }
  });
});

/**
 * One client over the real WebSocket RPC, signed in like a paired device, holding the
 * subscriptions a web client opens: the shell, VCS status of the project, and the given threads.
 * Succeeds once every subscription has delivered its snapshot.
 */
const attachClient = Effect.fn("serverMetrics.attachClient")(function* (
  server: Server,
  token: string,
  threadIds: ReadonlyArray<string>,
  /** Sees every item a thread subscription delivers, the snapshot included. */
  onThreadItem: (
    threadId: string,
    item: OrchestrationV2ThreadStreamItem,
  ) => Effect.Effect<void> = () => Effect.void,
) {
  const http = yield* HttpClient.HttpClient;
  // Headers alone do not finish a request; the deadline covers the body too.
  const ticketBody = yield* http
    .execute(
      HttpClientRequest.post(`${server.origin}/api/auth/websocket-ticket`).pipe(
        HttpClientRequest.bearerToken(token),
      ),
    )
    .pipe(
      Effect.flatMap((response) => response.text),
      Effect.timeoutOrElse({
        duration: Duration.seconds(15),
        orElse: () => new MetricsError({ message: "the WebSocket ticket never arrived" }),
      }),
    );
  const { ticket } = yield* decodeJson(Schema.Struct({ ticket: Schema.String }))(ticketBody);
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(
        Socket.layerWebSocket(
          `${server.origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`,
        ),
      ),
      Layer.provide(RpcSerialization.layerJson),
    ),
  );
  const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(protocol));
  // A subscription that fails or ends after its snapshot leaves the window measuring less than a
  // client costs, so the first such loss is kept for `healthy` to report.
  const lost = yield* Ref.make<string | undefined>(undefined);
  const ready = Effect.fn("serverMetrics.subscription")(function* <A, E, R>(
    stream: Stream.Stream<A, E, R>,
    isReady: (item: A) => boolean,
    onItem: (item: A) => Effect.Effect<void> = () => Effect.void,
  ) {
    const synchronized = yield* Deferred.make<void, MetricsError>();
    const lose = (message: string) =>
      Ref.update(lost, (first) => first ?? message).pipe(
        Effect.andThen(Deferred.fail(synchronized, new MetricsError({ message }))),
      );
    yield* stream.pipe(
      Stream.runForEach((item) =>
        onItem(item).pipe(
          Effect.andThen(isReady(item) ? Deferred.succeed(synchronized, undefined) : Effect.void),
        ),
      ),
      Effect.andThen(lose("a subscription ended")),
      Effect.catchCause(() => lose("a subscription failed")),
      Effect.forkScoped,
    );
    return Deferred.await(synchronized);
  });
  // Reports presence the way the web client does, so work held for an active client runs.
  const clientId = `bench-${yield* Random.nextIntBetween(0, 1_000_000_000)}`;
  const report = Effect.gen(function* () {
    yield* client["server.reportClientActivity"]({
      clientId,
      clientKind: "web",
      visible: true,
      focused: true,
      recentlyInteracted: true,
      appState: "active",
      scopes: [{ type: "provider-status" }, { type: "vcs-status", cwd: server.project }],
      ttlMs: 45_000,
      observedAt: yield* DateTime.now,
    });
  }).pipe(
    // A server that keeps the socket open but never answers would otherwise hang the scenario.
    Effect.timeoutOrElse({
      duration: Duration.seconds(15),
      orElse: () => new MetricsError({ message: "an activity report got no answer" }),
    }),
  );
  let lastSent = yield* nowMs;
  yield* report;
  // Each renewal goes out 25 s after the previous send, however long its reply took; one that
  // would start past the lease's safe point marks the client lost instead.
  yield* Effect.gen(function* () {
    while (true) {
      const next = nextActivityReport(lastSent, yield* nowMs);
      if (next.late) {
        return yield* new MetricsError({ message: "an activity renewal missed its lease" });
      }
      yield* Effect.sleep(Duration.millis(next.waitMs));
      const sentAt = yield* nowMs;
      yield* report;
      if (activityRenewalMissed(lastSent, sentAt, yield* nowMs)) {
        return yield* new MetricsError({ message: "an activity renewal missed its lease" });
      }
      lastSent = sentAt;
    }
  }).pipe(
    Effect.catchCause(() => Ref.update(lost, (first) => first ?? "an activity report failed")),
    Effect.forkScoped,
  );
  const synchronized = (item: { readonly kind: string }) => item.kind === "synchronized";
  const waits = [
    yield* ready(
      client["orchestration.subscribeShell"]({
        requestCompletionMarker: true,
        omitIdleSubagents: true,
        omitOlderSettled: true,
      }),
      synchronized,
    ),
    yield* ready(client.subscribeVcsStatus({ cwd: server.project }), () => true),
    ...(yield* Effect.forEach(threadIds, (threadId) =>
      ready(
        client["orchestration.subscribeThread"]({
          threadId: ThreadId.make(threadId),
          requestCompletionMarker: true,
          acceptBoundedSnapshot: true,
          acceptDeferredWork: true,
          acceptCompactTurnItems: true,
          acceptCompactIds: true,
          acceptDedupedBodies: true,
        }),
        synchronized,
        (item) => onThreadItem(threadId, item),
      ),
    )),
  ];
  yield* Effect.all(waits, { concurrency: "unbounded", discard: true }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(60),
      orElse: () => new MetricsError({ message: "a subscription never synchronized" }),
    }),
  );
  return {
    /** Sends a message the way the composer does, starting a turn at once. */
    send: (threadId: string, messageId: string, text: string) =>
      client["orchestration.dispatchCommand"]({
        type: "message.dispatch",
        commandId: CommandId.make(messageId),
        threadId: ThreadId.make(threadId),
        messageId: MessageId.make(messageId),
        text,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      }),
    /** Fails if any of this client's subscriptions or reports was lost since it attached. */
    healthy: Effect.flatMap(Ref.get(lost), (message) =>
      message === undefined ? Effect.void : Effect.fail(new MetricsError({ message })),
    ),
  };
});

/**
 * Attaches one client per entry, each holding the shell, VCS status and its threads, lets them
 * settle, then drops all of them at once and reconnects them: the time until every subscription
 * delivered its snapshot again, and the loop delay across it.
 */
const reconnectAll = Effect.fn("serverMetrics.reconnectAll")(function* (
  server: Server,
  token: string,
  clientThreads: ReadonlyArray<ReadonlyArray<string>>,
) {
  // Each client gets its own scope so they can be dropped on cue; the server's scope still closes
  // any left open when a step fails or is interrupted.
  const clientScope = Effect.acquireRelease(Scope.make(), (scope, exit) =>
    Scope.close(scope, exit),
  );
  const attachAll = (scopes: ReadonlyArray<Scope.Closeable>) =>
    Effect.forEach(
      scopes,
      (scope, index) =>
        attachClient(server, token, clientThreads[index] ?? []).pipe(Scope.provide(scope)),
      { concurrency: "unbounded" },
    );
  const clients = yield* Effect.forEach(clientThreads, () => clientScope);
  const first = yield* attachAll(clients);
  yield* Effect.sleep(Duration.seconds(10));
  yield* Effect.forEach(first, (client) => client.healthy, { discard: true });
  yield* server.loopStart;
  const dropped = yield* nowMs;
  yield* Effect.forEach(clients, (scope) => Scope.close(scope, Exit.void), {
    concurrency: "unbounded",
    discard: true,
  });
  const reopened = yield* Effect.forEach(clientThreads, () => clientScope);
  const second = yield* attachAll(reopened);
  const resubscribedMs = Math.round((yield* nowMs) - dropped);
  const loop = yield* server.loopRead;
  // The first cohort again: a loss between its check and the drop happened in the reconnect.
  yield* Effect.forEach([...first, ...second], (client) => client.healthy, { discard: true });
  yield* Effect.forEach(reopened, (scope) => Scope.close(scope, Exit.void), { discard: true });
  return { resubscribedMs, loopDelayP99Ms: round(loop.p99), loopDelayMaxMs: round(loop.max) };
});

/**
 * Short turns back to back on one thread: how long a send takes to reach the API, how long the
 * end of the reply takes to become a finished run the CLI sees (turn end and checkpoint), the time
 * per turn, and the event-loop delay across all of them.
 */
const pipelineTurns = Effect.fn("serverMetrics.pipelineTurns")(function* (
  environment: Environment,
  server: Server,
  turns: number,
) {
  const [threadId] = yield* openThreads(server, 0, 1);
  if (threadId === undefined) return yield* new MetricsError({ message: "no pipeline thread" });
  const toRequest: number[] = [];
  const turnEnd: number[] = [];
  yield* server.loopStart;
  const first = yield* nowMs;
  for (let turn = 0; turn < turns; turn++) {
    const marker = `bench-run-${20_000 + turn}`;
    const started = yield* nowMs;
    const sent = yield* server.threadSend(threadId, `Short reply. ${marker}`);
    const done = yield* nowMs;
    if (sent.exitCode !== 0) {
      return yield* new MetricsError({
        message: `pipeline turn ${turn} failed: ${sent.stderr.trim() || sent.stdout.trim()}`,
      });
    }
    const request = environment.requests.find(
      (entry) => entry.agent && entry.marker === marker && entry.at >= started,
    );
    if (request?.endedAt === undefined) {
      return yield* new MetricsError({ message: `the agent request for ${marker} never ended` });
    }
    toRequest.push(request.at - started);
    turnEnd.push(done - request.endedAt);
  }
  const elapsed = (yield* nowMs) - first;
  const loop = yield* server.loopRead;
  return {
    toRequestMs: spread(toRequest),
    turnEndMs: spread(turnEnd),
    msPerTurn: Math.round(elapsed / turns),
    loopDelayP99Ms: round(loop.p99),
    loopDelayMaxMs: round(loop.max),
    gcPauseMs: round(loop.gcMs),
  };
});

const TERMINAL_RUN = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

/** Threads that each answered once in a worktree of their own, by id. */
const openWorktreeThreads = Effect.fn("serverMetrics.openWorktreeThreads")(function* (
  server: Server,
  count: number,
) {
  const answers = yield* Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    (index) => server.threadStart(`Say hello ${index}.`, ["--wait", "--worktree", "main"]),
    { concurrency: 5 },
  );
  const ids = answers.map((answer) => /^Thread (\S+)$/m.exec(answer.stderr)?.[1]);
  const failed = answers.find((answer, index) => answer.exitCode !== 0 || !ids[index]);
  if (failed) {
    return yield* new MetricsError({
      message: `a worktree thread failed to start: ${failed.stderr.trim() || failed.stdout.trim()}`,
    });
  }
  return ids.filter((id) => id !== undefined);
});

/**
 * Every given thread runs editing turns back to back, all at once, sent and watched by one client
 * subscribed to all of them, as the web client is. Each turn streams a reply, writes a file in the
 * thread's worktree through the agent's Write tool, and ends in a checkpoint of that change. The
 * window is measured while every thread is working; turns finished inside it are timed.
 */
const workingWindow = Effect.fn("serverMetrics.workingWindow")(function* (
  environment: Environment,
  server: Server,
  token: string,
  threadIds: ReadonlyArray<string>,
  timing: { readonly warmupSeconds: number; readonly windowSeconds: number },
  /** The first turn's marker number; each window needs its own range, as ids never repeat. */
  firstMarker: number,
) {
  // One pending turn per thread: its message id and when the run's end reached the client.
  const pending = new Map<string, { messageId: string; done: Deferred.Deferred<string> }>();
  const client = yield* attachClient(server, token, threadIds, (threadId, item) => {
    if (item.kind !== "event" || item.event.type !== "run.updated") return Effect.void;
    const run = item.event.payload;
    const turn = pending.get(threadId);
    if (!turn || run.userMessageId !== turn.messageId || !TERMINAL_RUN.has(run.status)) {
      return Effect.void;
    }
    return Deferred.succeed(turn.done, run.status).pipe(Effect.asVoid);
  });
  const turns: Array<{ endedAt: number; toRequest: number; turnEnd: number; turnMs: number }> = [];
  let stopping = false;
  let sequence = 0;
  const work = Effect.fn("serverMetrics.workingThread")(function* (threadId: string) {
    while (!stopping) {
      const marker = `bench-run-${firstMarker + sequence++}`;
      const messageId = `bench-message-${marker}`;
      const done = yield* Deferred.make<string>();
      pending.set(threadId, { messageId, done });
      const sentAt = yield* nowMs;
      yield* client.send(threadId, messageId, `Edit a file. ${EDIT_MARKER} ${marker}`);
      const status = yield* Deferred.await(done).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(120),
          orElse: () => new MetricsError({ message: `turn ${marker} never ended` }),
        }),
      );
      const endedAt = yield* nowMs;
      if (status !== "completed") {
        return yield* new MetricsError({ message: `turn ${marker} ended ${status}` });
      }
      const forTurn = environment.requests.filter(
        (request) => request.agent && request.marker === marker && request.at >= sentAt,
      );
      const first = forTurn.find((request) => !request.toolResult);
      const last = forTurn.findLast((request) => request.toolResult);
      if (first === undefined || last?.endedAt === undefined) {
        return yield* new MetricsError({
          message: `turn ${marker} never called its Write tool; is the Claude CLI's tool set unchanged?`,
        });
      }
      turns.push({
        endedAt,
        toRequest: first.at - sentAt,
        turnEnd: endedAt - last.endedAt,
        turnMs: endedAt - sentAt,
      });
    }
  });
  const workers = yield* Effect.forEach(threadIds, (threadId) => Effect.forkScoped(work(threadId)));
  // A failed turn ends the window at once instead of thinning it.
  const failed = Effect.forEach(workers, Fiber.join, {
    concurrency: "unbounded",
    discard: true,
  }).pipe(Effect.andThen(Effect.never));
  return yield* Effect.raceFirst(
    Effect.gen(function* () {
      yield* Effect.sleep(Duration.seconds(timing.warmupSeconds));
      const from = yield* nowMs;
      const window = yield* server.measure(timing.windowSeconds);
      const to = yield* nowMs;
      // Every thread finishes the turn it is on, so the next window starts from idle threads.
      stopping = true;
      yield* Effect.forEach(workers, Fiber.join, { discard: true });
      yield* client.healthy;
      const inside = turns.filter((turn) => turn.endedAt >= from && turn.endedAt <= to);
      if (inside.length === 0) {
        return yield* new MetricsError({ message: "no turn finished inside the window" });
      }
      const point: WorkingPoint = {
        ...window,
        turnsPerMin: round((inside.length / (to - from)) * 60_000),
        toRequestMs: spread(inside.map((turn) => turn.toRequest)),
        turnEndMs: spread(inside.map((turn) => turn.turnEnd)),
        turnMs: spread(inside.map((turn) => turn.turnMs)),
      };
      return point;
    }),
    failed,
  );
}, Effect.scoped);

const SCENARIOS = [
  "startup",
  "rest",
  "firstWord",
  "quiet",
  "streaming",
  "clients",
  "pipeline",
  "working",
  "busy",
] as const;
/** Scenarios that read the developer's real database, so they run only when named. */
const OPT_IN_SCENARIOS: ReadonlyArray<string> = ["busy"];

interface RunOptions {
  readonly checkout: string;
  readonly noAgentScope: boolean;
  readonly runs: number;
  readonly threads: ReadonlyArray<number>;
  readonly only: ReadonlyArray<string>;
  readonly soakMinutes: number;
  /** A seeded base dir for the busy scenario. */
  readonly seed: string | undefined;
  readonly ballastMB: number;
  /** Also runs the upper-bound stress cases, such as the 20-client reconnect storm. */
  readonly stress: boolean;
  readonly profile: Profile;
  /** Where full CPU and allocation profiles go; none are written without it. */
  readonly profileDir: string | undefined;
}

/** One pass: startup, rest and firstWord share a server; quiet, streaming and soak get their own. */
const runOnce = Effect.fn("serverMetrics.runOnce")(function* (options: RunOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const machine = yield* watchMachine;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-server-metrics-" });
  const api = yield* serveFakeAnthropic();
  const environment: Environment = {
    home,
    apiPort: api.port,
    requests: api.requests,
    noAgentScope: options.noAgentScope,
    serverDir: path.join(options.checkout, "apps/server"),
    checkout: options.checkout,
  };
  const wanted = (scenario: string) =>
    options.only.includes(scenario) ||
    (options.only.length === 0 && !OPT_IN_SCENARIOS.includes(scenario));
  const measured: { -readonly [K in keyof Measured]: Measured[K] } = {};
  const profiles: Record<string, ProfileSummary> = {};
  let soakHeapGrowth: ReturnType<typeof heapGrowth> | undefined;
  const withServer = <A, E, R>(
    name: string,
    body: (server: Server) => Effect.Effect<A, E, R>,
    serverOptions: ServerOptions = {},
  ) =>
    Effect.scoped(Effect.flatMap(startServer(environment, name, serverOptions), body)).pipe(
      // Names the scenario and its cause in one line, instead of a stack from deep in the RPC client.
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.fail(
            new MetricsError({
              message: `the ${name} scenario failed: ${describeFailure(Cause.squash(cause))}`,
            }),
          ),
      ),
    );
  const profile = Effect.fn("serverMetrics.saveProfile")(function* (server: Server, name: string) {
    const { summary, raw } = yield* server.profile(options.profile.profileSeconds);
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
          yield* Effect.sleep(Duration.seconds(options.profile.settleSeconds));
          measured.rest = yield* server.measure(options.profile.windowSeconds);
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
          yield* Effect.sleep(Duration.seconds(options.profile.settleSeconds));
          points.push({ threads, window: yield* server.measure(options.profile.windowSeconds) });
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
  if (wanted("clients")) {
    yield* withServer("clients", (server) =>
      Effect.gen(function* () {
        const token = yield* server.issueToken;
        const most = Math.max(
          RECONNECT_THREADS,
          options.stress ? STORM_CLIENTS : 0,
          ...options.threads,
        );
        const threads = yield* openThreads(server, 0, most);
        const attached: Record<string, Window> = {};
        for (const count of options.threads) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const client = yield* attachClient(server, token, threads.slice(0, count));
              yield* Effect.sleep(Duration.seconds(options.profile.settleSeconds));
              attached[`${count}`] = yield* server.measure(options.profile.windowSeconds);
              yield* client.healthy;
            }),
          );
        }
        const reconnect = yield* reconnectAll(
          server,
          token,
          Array.from({ length: RECONNECT_CLIENTS }, () => threads.slice(0, RECONNECT_THREADS)),
        );
        // Every client holds the shell, VCS status and one thread, then all drop and come back.
        const storm = options.stress
          ? yield* reconnectAll(
              server,
              token,
              threads.slice(0, STORM_CLIENTS).map((thread) => [thread]),
            )
          : undefined;
        measured.clients = {
          attached,
          reconnect: {
            clients: RECONNECT_CLIENTS,
            threadsPerClient: RECONNECT_THREADS,
            ...reconnect,
          },
          ...(storm ? { storm: { clients: STORM_CLIENTS, ...storm } } : {}),
        };
      }),
    );
  }
  if (wanted("working")) {
    yield* withServer("working", (server) =>
      Effect.gen(function* () {
        const token = yield* server.issueToken;
        const counts = options.profile.workingThreads;
        const threads = yield* openWorktreeThreads(server, Math.max(...counts));
        const active: Record<string, WorkingPoint> = {};
        for (const [index, count] of counts.entries()) {
          active[`${count}`] = yield* workingWindow(
            environment,
            server,
            token,
            threads.slice(0, count),
            {
              warmupSeconds: options.profile.workingWarmupSeconds,
              windowSeconds: options.profile.workingSeconds,
            },
            30_000 + index * 10_000,
          );
        }
        const fit = (pick: (point: WorkingPoint) => number) =>
          round(slope(counts.map((count) => [count, pick(active[`${count}`]!)] as const)), 3);
        measured.working = {
          active,
          heapMBPerThread: fit((point) => point.heapAfterGcMB),
          rssMBPerThread: fit((point) => point.rssMB),
          cpuPctPerThread: fit((point) => point.cpuPct),
          loopDelayP99MsPerThread: fit((point) => point.loopDelayP99Ms ?? 0),
        };
      }),
    );
  }
  if (wanted("pipeline")) {
    yield* withServer("pipeline", (server) =>
      Effect.gen(function* () {
        measured.pipeline = yield* pipelineTurns(
          environment,
          server,
          options.profile.pipelineTurns,
        );
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
        measured.streaming = yield* server.measure(options.profile.streamingSeconds);
        yield* profile(server, "streaming");
      }),
    );
  }
  if (wanted("busy")) {
    if (options.seed === undefined) {
      return yield* new MetricsError({ message: "the busy scenario needs a seeded database" });
    }
    yield* withServer(
      "busy",
      (server) =>
        Effect.gen(function* () {
          yield* server.ballast(options.ballastMB);
          yield* Effect.sleep(Duration.seconds(options.profile.settleSeconds * 2));
          const rest = yield* server.measure(options.profile.windowSeconds);
          yield* server.assertIdle(server.startedAt);
          const shell = yield* loadShell(server, 5);
          const largest = server.largest;
          const thread = largest && (yield* loadThread(server, largest.threadId, 5));
          const traffic = yield* gitTraffic(server);
          // The traffic only ends by failing, which then fails the window instead of thinning it.
          const git = yield* Effect.raceFirst(
            Effect.gen(function* () {
              yield* Effect.sleep(Duration.seconds(5));
              const window = yield* server.measure(options.profile.windowSeconds);
              yield* profile(server, "busyGit");
              return window;
            }),
            traffic,
          );
          measured.busy = {
            readyMs: server.readyMs,
            projects: server.roots.length,
            ballastMB: options.ballastMB,
            rest,
            shellMs: shell.ms,
            shellKB: shell.KB,
            ...(largest && thread
              ? {
                  largeThread: {
                    messages: largest.messages,
                    openMs: thread.ms,
                    KB: thread.KB,
                    heapMB: thread.heapMB,
                  },
                }
              : {}),
            git,
          };
        }),
      { seed: options.seed },
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
          // Round robin, so two soaks send the same turns to the same threads.
          const threadId = threads[turn % threads.length];
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
  measured.machine = yield* machine;
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

/** Comm names of the processes that compete with a measured server on a developer's machine. */
const COMPETING = /^(node|node-MainThread|t3|claude|codex|vite|pnpm)/;

/**
 * CPU seconds of every node, T3, claude or codex process outside this script's own tree, keyed by
 * pid and start time so a reused pid is a new process. Linux only; elsewhere none, and the run
 * records only the load average.
 */
const competingCpuSeconds = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform !== "linux") return Option.none<ReadonlyMap<string, number>>();
  const fs = yield* FileSystem.FileSystem;
  const self = Number(yield* fs.readLink("/proc/self"));
  const parents = new Map<number, number>();
  const cpu = new Map<number, { key: string; seconds: number }>();
  for (const entry of yield* fs.readDirectory("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = yield* fs
      .readFileString(`/proc/${entry}/stat`)
      .pipe(Effect.orElseSucceed(() => ""));
    const open = stat.indexOf(" (");
    const close = stat.lastIndexOf(") ");
    if (open < 0 || close < 0) continue;
    const fields = stat.slice(close + 2).split(" ");
    const pid = Number(entry);
    parents.set(pid, Number(fields[1]));
    if (COMPETING.test(stat.slice(open + 2, close))) {
      // Fields after the name start at the state, field 3: utime 14, stime 15, starttime 22.
      cpu.set(pid, {
        key: `${pid}:${fields[19]}`,
        seconds: (Number(fields[11]) + Number(fields[12])) / 100,
      });
    }
  }
  const ours = (pid: number) => {
    for (let at: number | undefined = pid; at !== undefined && at > 1; at = parents.get(at)) {
      if (at === self) return true;
    }
    return false;
  };
  return Option.some(
    new Map([...cpu].filter(([pid]) => !ours(pid)).map(([, { key, seconds }]) => [key, seconds])),
  );
}).pipe(Effect.orElseSucceed(() => Option.none<ReadonlyMap<string, number>>()));

/** How often the machine watcher reads competing CPU; a process that exits loses at most this. */
const MACHINE_SAMPLE_SECONDS = 10;

const load1 = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform === "win32") return Option.none<number>();
  if (platform === "linux") {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString("/proc/loadavg").pipe(Effect.option);
    return Option.map(text, (value) => Number(value.split(" ")[0]));
  }
  const text = yield* output("sysctl", ["-n", "vm.loadavg"]);
  return Option.map(text, (value) => Number(value.replace(/[{}]/g, "").trim().split(/\s+/)[0]));
}).pipe(Effect.map(Option.filter(Number.isFinite)));

/**
 * Starts watching the machine for one run; the returned effect reads what competed with it: the
 * highest 1-minute load seen and the cores other T3, node and agent processes kept busy.
 */
const watchMachine = Effect.gen(function* () {
  const startedAt = yield* nowMs;
  const loads: number[] = [];
  // Unknown (none) once any read fails, so a partial sum never passes for the whole run.
  let competing: Option.Option<number> = Option.some(0);
  let previous = yield* competingCpuSeconds;
  if (Option.isNone(previous)) competing = Option.none();
  // The periodic and final reads would otherwise interleave across the await below.
  const reading = yield* Semaphore.make(1);
  const read = Effect.gen(function* () {
    loads.push(...Option.toArray(yield* load1));
    if (Option.isNone(previous) || Option.isNone(competing)) return;
    const next = yield* competingCpuSeconds;
    if (Option.isNone(next)) {
      competing = Option.none();
      return;
    }
    competing = Option.some(competing.value + competingBetween(previous.value, next.value));
    previous = next;
  }).pipe(reading.withPermits(1));
  yield* read;
  // Reading through the run, not only at its ends, keeps a busy process that exits mid-run.
  yield* read.pipe(
    Effect.delay(Duration.seconds(MACHINE_SAMPLE_SECONDS)),
    Effect.forever,
    Effect.forkScoped,
  );
  return Effect.gen(function* () {
    yield* read;
    const elapsed = ((yield* nowMs) - startedAt) / 1_000;
    const machine: MachineState = {
      load1: loads.length ? round(Math.max(...loads), 2) : null,
      otherCpuCores:
        Option.isSome(competing) && elapsed > 0 ? round(competing.value / elapsed, 2) : null,
      minutes: round(elapsed / 60, 1),
    };
    return machine;
  });
});

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
    profile: options.profile === PROFILES.quick ? "quick" : "full",
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
  if (Option.isNone(out)) return yield* Console.log(json);
  // A sibling then a rename, so a failed write keeps the previous file whole.
  const temp = `${out.value}.tmp`;
  yield* fs.writeFileString(temp, `${json}\n`);
  yield* fs.rename(temp, out.value);
});

/**
 * Runs A and B alternately, saving a side after each of its runs so a failure keeps the finished
 * runs. On a failure it reports how many runs of each side reached disk.
 */
export const runAbRounds = Effect.fn("serverMetrics.abRounds")(function* <
  A,
  S,
  E,
  R,
  ES,
  RS,
>(options: {
  readonly rounds: number;
  readonly outDir: string;
  readonly runSide: (side: 0 | 1) => Effect.Effect<A, E, R>;
  readonly save: (side: 0 | 1, runs: ReadonlyArray<A>) => Effect.Effect<S, ES, RS>;
}) {
  const runs: [A[], A[]] = [[], []];
  const persisted = [0, 0];
  const saveSide = Effect.fn("serverMetrics.abSave")(function* (side: 0 | 1) {
    const count = runs[side].length;
    const saved = yield* options.save(side, runs[side]);
    persisted[side] = count;
    return saved;
  });
  const saved: [S, S] = [yield* saveSide(0), yield* saveSide(1)];
  yield* Effect.gen(function* () {
    for (let round = 0; round < options.rounds; round++) {
      // A B, then B A, so a drift in machine load lands on both sides.
      for (const side of round % 2 === 0 ? ([0, 1] as const) : ([1, 0] as const)) {
        yield* Console.error(`round ${round + 1}/${options.rounds}: ${side === 0 ? "A" : "B"}`);
        runs[side].push(yield* options.runSide(side));
        saved[side] = yield* saveSide(side);
      }
    }
  }).pipe(
    Effect.onError(() =>
      Console.error(
        `ab stopped early; ${options.outDir} keeps ${persisted[0]} A and ${persisted[1]} B runs`,
      ),
    ),
  );
  return saved;
});

/** Prints the comparison and sets exit code 1 when a metric got worse. */
const report = Effect.fn("serverMetrics.report")(function* (
  before: ServerMetrics,
  after: ServerMetrics,
  threshold: number,
) {
  const mismatch = profileMismatch(before, after);
  if (mismatch !== undefined) return yield* new MetricsError({ message: mismatch });
  const { table, regressed, improved, informational, compared, warnings } = compareMetrics(
    before,
    after,
    threshold,
  );
  yield* Console.log(table);
  for (const warning of warnings) yield* Console.error(`Warning: ${warning}`);
  if (compared === 0) {
    return yield* new MetricsError({
      message: "the two files share no metric, so nothing was compared",
    });
  }
  if (informational.length) {
    yield* Console.error(`Moved, but too noisy to gate on: ${informational.join(", ")}`);
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
    Flag.withDescription("firstWord runs in each variant. Default 5, 3 with --quick."),
    Flag.optional,
  ),
  threads: Flag.String("threads").pipe(
    Flag.withDescription(
      "Open thread counts the quiet and clients scenarios measure. Default 0,5,10,20; 0,10 with --quick.",
    ),
    Flag.optional,
  ),
  quick: Flag.Boolean("quick").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Shorter windows, fewer turns and fewer points (about a third of the time), for a per-PR or nightly check. Compare quick runs only with quick runs.",
    ),
  ),
  only: Flag.String("only").pipe(
    Flag.withDescription(`Scenarios to run, comma separated: ${SCENARIOS.join(", ")}.`),
    Flag.optional,
  ),
  seedDir: Flag.String("seed-dir").pipe(
    Flag.withDescription(
      "busy: a base dir `vp run migrate-dev-db --base-dir <dir>` already seeded, instead of seeding each checkout on every invocation.",
    ),
    Flag.optional,
  ),
  busyProjects: Flag.Int("busy-projects").pipe(
    Flag.withSchema(PositiveInt),
    Flag.withDescription("busy: projects to keep from the real database, each backed by a clone."),
    Flag.withDefault(10),
  ),
  busyThreads: Flag.Int("busy-threads").pipe(
    Flag.withSchema(PositiveInt),
    Flag.withDescription("busy: stopped threads to keep per project."),
    Flag.withDefault(200),
  ),
  busyBallast: Flag.Int("busy-ballast-mb").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    Flag.withDescription(
      "busy: MB the server retains off-heap, so its RSS matches a server open for days. A seeded database alone keeps RSS near 0.5 GB.",
    ),
    Flag.withDefault(768),
  ),
  stress: Flag.Boolean("stress").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Also run upper bounds no user hits daily: clients drops 20 clients at once and reconnects them. Compare stress numbers only with stress numbers.",
    ),
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
  readonly runs: Option.Option<number>;
  readonly threads: Option.Option<string>;
  readonly quick: boolean;
  readonly only: Option.Option<string>;
  readonly soak: number;
  readonly seedDir: Option.Option<string>;
  readonly busyProjects: number;
  readonly busyThreads: number;
  readonly busyBallast: number;
  readonly stress: boolean;
}

const toRunOptions = Effect.fn("serverMetrics.toRunOptions")(function* (
  flags: RunFlags,
  checkout: string,
  profileDir: string | undefined,
) {
  const path = yield* Path.Path;
  const profile = flags.quick ? PROFILES.quick : PROFILES.full;
  const selection = parseRunSelection({
    only: Option.getOrElse(flags.only, () => ""),
    threads: Option.getOrElse(flags.threads, () => profile.threads),
    soak: flags.soak,
    scenarios: SCENARIOS,
  });
  if ("error" in selection) return yield* new MetricsError({ message: selection.error });
  const { only, threads } = selection;
  const options: RunOptions = {
    checkout: path.resolve(checkout),
    noAgentScope: flags.noAgentScope,
    runs: Option.getOrElse(flags.runs, () => profile.runs),
    threads,
    only,
    soakMinutes: flags.soak,
    profileDir,
    seed: undefined,
    ballastMB: flags.busyBallast,
    stress: flags.stress,
    profile,
  };
  return options;
});

/** The busy scenario's seed for these options: the given dir, or the checkout's own seeding. */
const withSeed = Effect.fn("serverMetrics.withSeed")(function* (
  options: RunOptions,
  flags: RunFlags,
) {
  const path = yield* Path.Path;
  if (!options.only.includes("busy")) return options;
  const seed = Option.isSome(flags.seedDir)
    ? path.resolve(flags.seedDir.value)
    : yield* prepareSeed(options.checkout, flags.busyProjects, flags.busyThreads);
  const seeded: RunOptions = { ...options, seed };
  return seeded;
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
    const unseeded = yield* toRunOptions(input, checkout, profileDir);
    // Checks the machine before seeding, which takes minutes.
    const meta = yield* metaFor(unseeded);
    const options = yield* withSeed(unseeded, input);
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
  }, Effect.scoped),
).pipe(
  Command.withDescription(
    "Measure a checkout's server: startup, rest and first word on one server, then quiet threads (with their cost per thread), clients, many threads working, the turn pipeline, streaming and an optional soak on servers of their own. Needs the real claude CLI on PATH; on Windows the native claude.exe from claude.ai/install.ps1, since an npm claude.cmd shim cannot be started without a shell.",
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
    const unseeded = [
      yield* toRunOptions(input, input.checkoutA, undefined),
      yield* toRunOptions(input, input.checkoutB, undefined),
    ] as const;
    // Checks the machine before seeding, which takes minutes.
    const metas = [yield* metaFor(unseeded[0]), yield* metaFor(unseeded[1])] as const;
    const sides = [
      yield* withSeed(unseeded[0], input),
      yield* withSeed(unseeded[1], input),
    ] as const;
    // Written up front and after every run; compare takes unequal run counts.
    const saved = yield* runAbRounds({
      rounds: input.rounds,
      outDir,
      runSide: (side) => runOnce(sides[side]).pipe(Effect.map((run) => run.measured)),
      save: Effect.fn("serverMetrics.abSaveFile")(function* (side, runs) {
        const file: ServerMetrics = {
          meta: { ...metas[side], loadAfter: yield* machineLoad },
          runs: [...runs],
        };
        yield* writeMetrics(Option.some(path.join(outDir, side === 0 ? "a.json" : "b.json")), file);
        return file;
      }),
    });
    yield* report(saved[0], saved[1], input.threshold);
  }, Effect.scoped),
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
    "Markdown table of two result files, lower is better. With 2+ runs a side, a metric counts only when the 95% bootstrap interval of the median difference clears the threshold and its noise floor, measured from A/A runs (see `noise`). Metrics too noisy to gate on are shown but never counted. Warns when either side ran under heavy machine load. Exits 1 on a regression.",
  ),
);

const noiseCommand = Command.make(
  "noise",
  {
    dirs: Argument.String("dir").pipe(
      Argument.withDescription("An `ab` out dir (a.json and b.json) of one commit against itself."),
      Argument.atLeast(1),
    ),
  },
  Effect.fn("serverMetrics.noise")(function* (input) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const read = (file: string) =>
      fs.readFileString(file).pipe(Effect.flatMap(decodeJson(ServerMetrics)));
    const pairs = yield* Effect.forEach(input.dirs, (dir) =>
      Effect.gen(function* () {
        const a = yield* read(path.join(dir, "a.json"));
        const b = yield* read(path.join(dir, "b.json"));
        const problem = noisePairProblem(dir, a, b);
        if (problem !== undefined) return yield* new MetricsError({ message: problem });
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
    const { warning } = noiseRulesFor(pairs.flat());
    if (warning !== undefined) yield* Console.error(`Warning: ${warning}`);
    const { rows, table } = noiseReport(pairs);
    if (rows.length === 0) {
      return yield* new MetricsError({
        message: "no metric was measured on both sides of any pair, so nothing was calibrated",
      });
    }
    yield* Console.log(table);
  }),
).pipe(
  Command.withDescription(
    "Spread of every metric over A/A runs (`ab <same> <same>`), an estimated floor covering the half ranges and median differences these runs showed, and which metrics are too noisy to gate on. ⚠ marks a current floor under the estimate. Refuses directories whose two files record different commits.",
  ),
);

const serverMetricsCommand = Command.make("server-metrics").pipe(
  Command.withDescription(
    `Measure the server process against a fake Anthropic API and the real claude CLI, on Linux, macOS and Windows.

Which scenario answers what:
  working     Many threads editing files at once, one client watching all: steer performance work by its loop delay, turn end and turns per minute.
  pipeline    One thread's overhead per turn: send to API request, reply end to run end.
  clients     What an attached client costs, and a user's 3 devices reconnecting. --stress adds the 20-client storm, an upper bound.
  quiet       Idle cost per open thread (the scaling fit); rest is an idle server.
  streaming   CPU and loop delay while 5 replies stream.
  firstWord   A new thread's time to the API; startup is time to the first answer. Latency on a shared machine is noisy.
  busy        Opt-in: a copy of your real database, read-only, for costs an empty one hides.

Trust a change only from \`ab\` on one machine. compare gates on floors measured from A/A runs (\`noise\`), shows metrics too noisy to gate on without counting them, and warns when other processes loaded the machine; rerun then. --quick suits a per-PR or nightly check; decide on full runs.`,
  ),
  Command.withSubcommands([runCommand, abCommand, compareCommand, noiseCommand]),
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
    Effect.catchTags({
      MetricsError: (error) =>
        Console.error(`server-metrics: ${error.message}`).pipe(
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
