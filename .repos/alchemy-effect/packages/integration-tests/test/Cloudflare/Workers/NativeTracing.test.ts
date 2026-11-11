import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import {
  CloudflareTelemetryCompatibilityError,
  MIN_CLOUDFLARE_TRACING_DATE,
} from "@alchemy.run/cloudflare/Workers/Telemetry";
import type { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import { resolveObservability } from "@alchemy.run/cloudflare/Workers/WorkerAsyncBindings";
import { describe, expect, test as unit } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import type { ResourceBinding } from "alchemy/Resource";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { stageSuffix } from "../../names.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";
import type { TraceSink } from "./fixtures/native-tracing/collector.ts";
import NativeTracingWorker, { makeTracedWorker } from "./fixtures/native-tracing/worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

/**
 * A span row Workers Observability ingested: Cloudflare's own
 * `traceId` / `spanId` / `parentSpanId` (so the tree the platform recorded
 * can be checked directly) plus the `effect.exit` attribute the tracer
 * forwards on span end.
 */
interface SpanRow extends workers.ObservabilitySharedQueriesGetResponseEventsEventsItemMetadata {
  exit: unknown;
}

const exitOf = (source: unknown): unknown => {
  if (typeof source !== "object" || source === null) return undefined;
  const effect = (source as Record<string, unknown>).effect;
  return typeof effect === "object" && effect !== null
    ? (effect as Record<string, unknown>).exit
    : undefined;
};

const querySpans = (accountId: string, service: string) =>
  // The timeframe is re-evaluated per poll: rows are keyed by ingestion
  // time, so a window fixed at the first attempt never sees late arrivals.
  Effect.suspend(() =>
    workers.queryObservabilityTelemetry({
      accountId,
      queryId: "adhoc-native-tracing",
      view: "events",
      timeframe: { from: Date.now() - 15 * 60 * 1000, to: Date.now() },
      limit: 500,
      parameters: {
        filters: [
          {
            key: "$metadata.service",
            operation: "eq",
            type: "string",
            value: service,
          },
          { key: "$metadata.spanName", operation: "exists", type: "string" },
        ],
      },
    }),
  ).pipe(
    Effect.map((response) =>
      (response.events?.events ?? []).map((event): SpanRow => ({
        ...event.metadata,
        exit: exitOf(event.source),
      })),
    ),
  );

/** The spans of one request: the root matched by name + `request.id`, and every row sharing its trace. */
const traceOf = (spans: SpanRow[], root: string, id: string) => {
  const rootSpan = spans.find((s) => s.spanName === root && s.requestId === id);
  return rootSpan === undefined
    ? undefined
    : {
        root: rootSpan,
        spans: spans.filter((s) => s.traceId === rootSpan.traceId),
        /** Exactly one span of this name in the trace. */
        span: (name: string) => {
          const matches = spans.filter(
            (s) => s.traceId === rootSpan.traceId && s.spanName === name,
          );
          expect(matches).toHaveLength(1);
          return matches[0]!;
        },
      };
};

type Bindings = ReadonlyArray<ResourceBinding<Worker["Binding"]>>;

const tracesBind = (traces: NonNullable<Worker["Binding"]["observability"]>["traces"]): Bindings =>
  [{ sid: "Cloudflare.Telemetry", data: { observability: { traces } } }] as unknown as Bindings;

describe(
  "resolveObservability",
  {
    tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"],
  },
  () => {
    unit("omitted props + bound traces keep default logs", () => {
      const resolved = resolveObservability({}, tracesBind({ enabled: true }));
      expect(resolved.enabled).toBe(true);
      expect(resolved.logs?.enabled).toBe(true);
      expect(resolved.logs?.invocationLogs).toBe(true);
      expect(resolved.traces?.enabled).toBe(true);
    });

    unit("explicit traces.enabled false wins over the bind", () => {
      const resolved = resolveObservability(
        { observability: { enabled: true, traces: { enabled: false } } },
        tracesBind({ enabled: true, persist: true }),
      );
      expect(resolved.traces?.enabled).toBe(false);
      expect(resolved.traces?.persist).toBeUndefined();
    });

    unit("fills traces when news.observability exists without traces", () => {
      const resolved = resolveObservability(
        {
          observability: {
            enabled: true,
            logs: { enabled: true, invocationLogs: true, persist: true },
          },
        },
        tracesBind({ enabled: true, headSamplingRate: 1 }),
      );
      expect(resolved.logs?.persist).toBe(true);
      expect(resolved.traces?.enabled).toBe(true);
      expect(resolved.traces?.headSamplingRate).toBe(1);
    });

    unit("Issues coexist with Telemetry traces and explicit logs", () => {
      const resolved = resolveObservability(
        {
          observability: {
            enabled: true,
            logs: { enabled: true, invocationLogs: true },
            issues: { enabled: true },
          },
        },
        tracesBind({ enabled: true, headSamplingRate: 0.1 }),
      );
      expect(resolved.issues?.enabled).toBe(true);
      expect(resolved.logs?.invocationLogs).toBe(true);
      expect(resolved.traces?.enabled).toBe(true);
      expect(resolved.traces?.headSamplingRate).toBe(0.1);
    });

    unit("no bind returns default logs", () => {
      const resolved = resolveObservability({}, []);
      expect(resolved.traces).toBeUndefined();
      expect(resolved.logs?.invocationLogs).toBe(true);
    });
  },
);

test.provider(
  "Cloudflare.Telemetry() enables traces without clobbering default logs",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* NativeTracingWorker;
        }),
      );

      const settings = yield* workers.getScriptScriptAndVersionSetting({
        accountId,
        scriptName: worker.workerName,
      });
      expect(settings.observability?.enabled).toBe(true);
      expect(settings.observability?.logs?.enabled).toBe(true);
      expect(settings.observability?.logs?.invocationLogs).toBe(true);
      expect(settings.observability?.traces?.enabled).toBe(true);

      yield* expectUrlContains(`${worker.url}/work`, "native-did-work", {
        timeout: "180 seconds",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:kv",
      "provider:cloudflare:queue",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 180_000,
  },
);

test.provider(
  "explicit observability.traces wins over Cloudflare.Telemetry() bind",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* makeTracedWorker("NativeTracingOverride", {
            observability: {
              enabled: true,
              traces: { enabled: false },
            },
          });
        }),
      );

      const settings = yield* workers.getScriptScriptAndVersionSetting({
        accountId,
        scriptName: worker.workerName,
      });
      expect(settings.observability?.traces?.enabled).toBe(false);
      expect(settings.observability?.logs?.invocationLogs).toBe(true);

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:kv",
      "provider:cloudflare:queue",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 180_000,
  },
);

test.provider(
  "Cloudflare.Telemetry() fails deploy on a pre-startActiveSpan compatibility date",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* makeTracedWorker("NativeTracingOldDate", {
              compatibility: { date: "2026-03-17" },
            });
          }),
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(CloudflareTelemetryCompatibilityError);
      expect(String(error)).toContain(MIN_CLOUDFLARE_TRACING_DATE);
      expect(String(error)).toContain("2026-03-17");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:kv",
      "provider:cloudflare:queue",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 120_000,
  },
);

test.provider(
  "Effect spans appear in Workers Observability after Cloudflare.Telemetry()",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* NativeTracingWorker;
        }),
      );

      yield* expectUrlContains(`${worker.url}/work`, "native-did-work", {
        timeout: "180 seconds",
      });

      // Poll until the request's Effect spans have been ingested.
      const spans = yield* querySpans(accountId, worker.workerName).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (spans) =>
            spans.some((s) => s.spanName === "operation") &&
            spans.some((s) => s.spanName === "native.child"),
          times: 36,
        }),
      );
      expect(spans.map((s) => s.spanName)).toEqual(
        expect.arrayContaining(["operation", "native.child"]),
      );

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:kv",
      "provider:cloudflare:queue",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 300_000,
  },
);

const FANOUT_SPANS = [
  "operation",
  "child.a",
  "child.a.inner",
  "child.b",
  "child.b.inner",
  "forked",
  "forked.inner",
];

test.provider(
  "records the Effect span tree across fibers, exits, Durable Object and queue handlers",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* NativeTracingWorker;
        }),
      );
      yield* expectUrlContains(`${worker.url}/fanout?id=warmup`, "native-did-fanout", {
        timeout: "180 seconds",
      });

      // Each request retries through workers.dev propagation (a colo can
      // still serve Cloudflare's error page right after the warm-up
      // succeeded elsewhere); a retried id just produces one more
      // independent trace.
      const hit = (path: string, id: string, marker = id) =>
        expectUrlContains(`${worker.url}${path}?id=${id}`, marker, {
          timeout: "120 seconds",
        });
      // One request shape per event path. A request's trace is located by
      // the `request.id` annotated on its root span (`$metadata.requestId`)
      // and is complete once every expected span arrived, plus a platform
      // span (e.g. the KV read) under each span in `platformUnder`.
      const shapes = [
        {
          name: "fanout",
          root: "operation",
          names: FANOUT_SPANS,
          platformUnder: ["child.a", "child.b", "forked"],
          // Several in flight at once so fibers from different requests
          // interleave inside the isolate.
          send: (id: string) => hit("/fanout", id),
          concurrent: 3,
        },
        {
          name: "exits",
          root: "operation",
          names: ["operation", "failing.child", "interrupted.child"],
          platformUnder: [],
          send: (id: string) => hit("/exits", id),
          concurrent: 1,
        },
        {
          name: "rpc",
          root: "do.operation",
          names: ["do.operation", "do.inner"],
          platformUnder: [],
          send: (id: string) => hit("/rpc", id, "native-did-rpc:do-ok"),
          concurrent: 1,
        },
        {
          name: "queue",
          root: "queue.operation",
          names: ["queue.operation", "queue.inner"],
          platformUnder: [],
          send: (id: string) => hit("/enqueue", id),
          concurrent: 1,
        },
      ] as const;
      type Shape = (typeof shapes)[number];
      const complete = (spans: SpanRow[], shape: Shape, id: string) => {
        const trace = traceOf(spans, shape.root, id);
        return (
          trace !== undefined &&
          shape.names.every((name) => trace.spans.some((s) => s.spanName === name)) &&
          shape.platformUnder.every((name) =>
            trace.spans.some(
              (parent) =>
                parent.spanName === name &&
                trace.spans.some(
                  (s) =>
                    s.parentSpanId === parent.spanId && !FANOUT_SPANS.includes(s.spanName ?? ""),
                ),
            ),
          )
        );
      };
      // Every id sent per shape, so a trace that arrives late still counts.
      const sent = new Map<Shape, string[]>(shapes.map((shape) => [shape, []]));
      const send = (shape: Shape) =>
        Effect.gen(function* () {
          const ids = yield* Effect.sync(() => {
            const ids = Array.from({ length: shape.concurrent }, () =>
              globalThis.crypto.randomUUID(),
            );
            sent.get(shape)!.push(...ids);
            return ids;
          });
          yield* Effect.all(ids.map(shape.send), { concurrency: "unbounded" });
        });
      yield* Effect.all(
        [
          ...shapes.map(send),
          // Head sampling 1: every Effect span is sampled.
          expectUrlContains(`${worker.url}/sampled`, '"operation":true,"child":true', {
            timeout: "120 seconds",
          }),
        ],
        { concurrency: "unbounded" },
      );

      // Ingestion latency varies from seconds to several minutes, and
      // ingestion is lossy: a span and the platform spans under it can go
      // missing for good, so waiting on one request can never finish. Every
      // minute, send a fresh request for each shape that has no complete
      // trace yet; the assertions below run on the traces that arrived whole.
      const completeIds = (spans: SpanRow[], shape: Shape) =>
        sent.get(shape)!.filter((id) => complete(spans, shape, id));
      let polls = 0;
      const poll = Effect.gen(function* () {
        const spans = yield* querySpans(accountId, worker.workerName);
        const missing = shapes.filter((shape) => completeIds(spans, shape).length === 0);
        const count = yield* Effect.sync(() => ++polls);
        if (missing.length > 0 && count % 12 === 0) {
          yield* Effect.logInfo(
            `native-tracing: no complete trace yet for ${missing.map((s) => s.name).join(", ")}; sending again`,
          );
          yield* Effect.all(missing.map(send), { concurrency: "unbounded" });
        }
        return { spans, missing };
      });
      const { spans, missing } = yield* poll.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (result) => result.missing.length === 0,
          times: 60,
        }),
      );
      if (missing.length > 0) {
        yield* Effect.logError(
          `native-tracing: no complete trace for ${missing.map((s) => s.name).join(", ")}; spans ingested so far: ${JSON.stringify(
            spans.map((s) => [s.requestId, s.traceId, s.spanName]),
          )}`,
        );
      }
      expect(missing.map((shape) => shape.name)).toEqual([]);
      const [fanout, exits, rpc, queue] = shapes;
      const ids = {
        fanout: completeIds(spans, fanout),
        exits: completeIds(spans, exits)[0]!,
        rpc: completeIds(spans, rpc)[0]!,
        queue: completeIds(spans, queue)[0]!,
      };

      // Fan-out: siblings and nesting follow the Effect span tree, and each
      // KV read (a Cloudflare auto-instrumented span) is attributed to the
      // branch whose fiber issued it — even though the scheduler resumed
      // that fiber on a timer tick outside `operation`'s async context.
      for (const id of ids.fanout) {
        const trace = traceOf(spans, "operation", id)!;
        const operation = trace.root;
        // `operation` hangs off Cloudflare's own request span.
        expect(
          trace.spans.some(
            (s) => s.spanId === operation.parentSpanId && s.spanName !== "operation",
          ),
        ).toBe(true);
        for (const name of ["child.a", "child.b", "forked"]) {
          const branch = trace.span(name);
          expect(branch.parentSpanId).toBe(operation.spanId);
          expect(trace.span(`${name}.inner`).parentSpanId).toBe(branch.spanId);
          const platform = trace.spans.filter(
            (s) => s.parentSpanId === branch.spanId && !FANOUT_SPANS.includes(s.spanName ?? ""),
          );
          expect(platform.length).toBeGreaterThanOrEqual(1);
        }
        expect(operation.exit).toBe("success");
      }

      // Exits: the failing child (caught by its parent) and the interrupted
      // child record their outcome as `effect.exit`.
      {
        const trace = traceOf(spans, "operation", ids.exits)!;
        expect(trace.root.exit).toBe("success");
        const failing = trace.span("failing.child");
        expect(failing.parentSpanId).toBe(trace.root.spanId);
        expect(failing.exit).toBe("failure");
        const interrupted = trace.span("interrupted.child");
        expect(interrupted.parentSpanId).toBe(trace.root.spanId);
        expect(interrupted.exit).toBe("interrupted");
      }

      // Durable Object RPC: spans opened inside the DO method nest under
      // the DO invocation's platform span.
      {
        const trace = traceOf(spans, "do.operation", ids.rpc)!;
        expect(trace.root.parentSpanId).toBeTruthy();
        expect(trace.span("do.inner").parentSpanId).toBe(trace.root.spanId);
        expect(trace.root.exit).toBe("success");
      }

      // Queue consumer: same for the `queue` event handler.
      {
        const trace = traceOf(spans, "queue.operation", ids.queue)!;
        expect(trace.root.parentSpanId).toBeTruthy();
        expect(trace.span("queue.inner").parentSpanId).toBe(trace.root.spanId);
        expect(trace.root.exit).toBe("success");
      }

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:kv",
      "provider:cloudflare:queue",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 480_000,
  },
);

// The OTLP collector the export test's observability destination pushes
// to. Cloudflare's exporter needs a public hostname, so the collector
// gets a deterministic custom domain on the standing test zone.
const zoneName = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";
const collectorHost = `native-trace-collector-${stageSuffix()}.${zoneName}`;
// Named up front: the traced Worker lists the destination by name.
const destinationName = `native-trace-export-${stageSuffix()}`;
const collectorMain = pathe.resolve(import.meta.dirname, "fixtures/native-tracing/collector.ts");

/** An exported OTLP span, reduced to what the status assertions read. */
interface ExportedSpan {
  traceId: string;
  name: string;
  requestId: unknown;
  status: { code: "unset" | "ok" | "error"; message?: string };
}

// OTLP/JSON encodes the status code as its enum number or its name.
const statusCode = (code: unknown): ExportedSpan["status"]["code"] =>
  code === 2 || code === "STATUS_CODE_ERROR"
    ? "error"
    : code === 1 || code === "STATUS_CODE_OK"
      ? "ok"
      : "unset";

// The destination's preflight POST stores a non-OTLP body too.
const parseJson = (text: string): any => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const exportedSpans = (items: ReadonlyArray<string>): ExportedSpan[] =>
  items.flatMap((item) => {
    const body = parseJson(item);
    return (body?.resourceSpans ?? []).flatMap((resource: any) =>
      (resource.scopeSpans ?? []).flatMap((scope: any) =>
        (scope.spans ?? []).map((span: any): ExportedSpan => ({
          traceId: span.traceId,
          name: span.name,
          requestId: (span.attributes ?? []).find((a: any) => a.key === "request.id")?.value
            ?.stringValue,
          status: { code: statusCode(span.status?.code), message: span.status?.message },
        })),
      ),
    );
  });

test.provider(
  "exports a failed Effect span with error status over OTLP",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      // The traced Worker lists the destination by name, so the collector
      // and destination deploy first and stay declared in the second step.
      const sink = Effect.gen(function* () {
        const collector = yield* Cloudflare.Worker("NativeTraceCollector", {
          main: collectorMain,
          env: { SINK: Cloudflare.DurableObject<TraceSink>("TraceSink") },
          domain: collectorHost,
          compatibility: { date: "2024-09-23" },
        });
        yield* Cloudflare.Workers.ObservabilityDestination("NativeTraceDestination", {
          name: destinationName,
          url: `https://${collectorHost}/v1/traces`,
          logpushDataset: "opentelemetry-traces",
          // The collector's custom domain may not serve yet on create.
          skipPreflightCheck: true,
        });
        return collector;
      });
      yield* stack.deploy(sink);
      const { collector, worker } = yield* stack.deploy(
        Effect.gen(function* () {
          const collector = yield* sink;
          const worker = yield* makeTracedWorker("NativeTracingExport", {
            observability: {
              enabled: true,
              traces: { enabled: true, destinations: [destinationName] },
            },
          });
          return { collector, worker };
        }),
      );

      // Read back over workers.dev: a custom domain attached makes
      // `collector.url` the domain, so derive the workers.dev URL.
      const { subdomain } = yield* workers.getSubdomain({ accountId });
      const collected = `https://${collector.workerName}.${subdomain}.workers.dev/collected`;
      yield* expectUrlContains(collected, "trace-collector-ok", { timeout: "180 seconds" });
      yield* expectUrlContains(`${worker.url}/exits?id=warmup`, "native-did-exits", {
        timeout: "180 seconds",
      });

      // Export runs through Logpush batches, so a request's spans can take
      // minutes to arrive. Send a fresh `/exits` request every minute until
      // one request's whole trace has been exported.
      const client = yield* HttpClient.HttpClient;
      const sent: string[] = [];
      const send = Effect.gen(function* () {
        const id = yield* Effect.sync(() => {
          const id = globalThis.crypto.randomUUID();
          sent.push(id);
          return id;
        });
        yield* expectUrlContains(`${worker.url}/exits?id=${id}`, id, { timeout: "120 seconds" });
      });
      const traceFor = (spans: ExportedSpan[]) =>
        sent
          .map((id) => {
            const root = spans.find((s) => s.name === "operation" && s.requestId === id);
            const trace = spans.filter((s) => s.traceId === root?.traceId);
            const span = (name: string) => trace.find((s) => s.name === name);
            return root && span("failing.child") && span("interrupted.child")
              ? { root, failing: span("failing.child")!, interrupted: span("interrupted.child")! }
              : undefined;
          })
          .find((trace) => trace !== undefined);
      let polls = 0;
      const trace = yield* Effect.gen(function* () {
        const count = yield* Effect.sync(() => polls++);
        if (count % 12 === 0) yield* send;
        const body = (yield* client.get(collected).pipe(Effect.flatMap((res) => res.json))) as {
          items: string[];
        };
        return traceFor(exportedSpans(body.items));
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (trace) => trace !== undefined,
          times: 72,
        }),
      );

      expect(trace).toBeDefined();
      // A failure maps to the standard error status; success and pure
      // interruption stay unset.
      expect(trace!.failing.status).toEqual({ code: "error", message: "boom" });
      expect(trace!.interrupted.status.code).toBe("unset");
      expect(trace!.root.status.code).toBe("unset");

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:kv",
      "provider:cloudflare:queue",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 480_000,
  },
);

test.provider(
  "head sampling below 1 is applied by Cloudflare at ingestion",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const currentConfig = yield* ConfigProvider.ConfigProvider;
      yield* stack.destroy();

      const worker = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* makeTracedWorker("NativeTracingSampled");
          }),
        )
        .pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.orElse(
              ConfigProvider.fromUnknown({ HEAD_SAMPLING_RATE: 0.5 }),
              currentConfig,
            ),
          ),
        );

      const settings = yield* workers.getScriptScriptAndVersionSetting({
        accountId,
        scriptName: worker.workerName,
      });
      expect(settings.observability?.traces?.enabled).toBe(true);
      expect(settings.observability?.traces?.headSamplingRate).toBe(0.5);

      // The runtime reports every invocation as traced (`span.isTraced` does
      // not carry the head-sampling decision — a rate of 0 behaves the same),
      // so Effect's `sampled` flag stays true and consistent parent → child.
      // Sampling is applied when Cloudflare ingests: of N invocations, only
      // ~half persist.
      //
      // A 50% rate (rather than a few percent) keeps this test fast and
      // two-sided: some request of the batch is always persisted, so the
      // ingestion wait ends as soon as rows land instead of at its ceiling,
      // and the count can be bounded from below as well as above.
      const runId = yield* Effect.sync(() => globalThis.crypto.randomUUID());
      yield* expectUrlContains(`${worker.url}/sampled?id=warmup-${runId}`, "native-did-sample", {
        timeout: "180 seconds",
      });
      const client = yield* HttpClient.HttpClient;
      const probe = client.get(`${worker.url}/sampled?id=${runId}`).pipe(
        Effect.flatMap((res) => res.json),
        Effect.map((body) => body as { operation: boolean; child: boolean }),
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 30 }),
      );
      const requests = 100;
      const seen = yield* Effect.all(
        Array.from({ length: requests }, () => probe),
        { concurrency: 10 },
      );
      expect(seen.filter((b) => b.child !== b.operation)).toEqual([]);

      // One `operation` root per persisted request, keyed by this run's id
      // so earlier runs inside the 15-minute query window don't count.
      // Rows land in batches, so wait until two consecutive reads agree
      // (and enough exist to prove tracing is on) before bounding the count.
      // Binomial(100, 0.5) is within [20, 80] with P(miss) ≈ 1e-9; a few
      // retried probes add at most a handful of extra traces.
      const persistedCount = querySpans(accountId, worker.workerName).pipe(
        Effect.map(
          (spans) =>
            spans.filter((s) => s.spanName === "operation" && s.requestId === runId).length,
        ),
      );
      let previous = -1;
      const persisted = yield* persistedCount.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (count) => {
            const settled = count >= 20 && count === previous;
            previous = count;
            return settled;
          },
          times: 36,
        }),
      );
      expect(persisted).toBeGreaterThanOrEqual(20);
      expect(persisted).toBeLessThanOrEqual(80);

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:kv",
      "provider:cloudflare:queue",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 300_000,
  },
);
