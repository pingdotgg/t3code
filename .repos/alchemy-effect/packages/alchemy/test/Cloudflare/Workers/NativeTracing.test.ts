import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import {
  CloudflareTelemetryCompatibilityError,
  MIN_CLOUDFLARE_TRACING_DATE,
} from "@/Cloudflare/Workers/Telemetry.ts";
import { resolveObservability } from "@/Cloudflare/Workers/WorkerAsyncBindings.ts";
import type { Worker } from "@/Cloudflare/Workers/Worker.ts";
import type { ResourceBinding } from "@/Resource.ts";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect, test as unit } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import NativeTracingWorker, {
  makeTracedWorker,
} from "./fixtures/native-tracing/worker.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * A span row Workers Observability ingested: Cloudflare's own
 * `traceId` / `spanId` / `parentSpanId` (so the tree the platform recorded
 * can be checked directly) plus the `effect.exit` attribute the tracer
 * forwards on span end.
 */
interface SpanRow
  extends workers.ObservabilitySharedQueriesGetResponseEventsEventsItemMetadata {
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

const tracesBind = (
  traces: NonNullable<Worker["Binding"]["observability"]>["traces"],
): Bindings =>
  [
    { sid: "Cloudflare.Telemetry", data: { observability: { traces } } },
  ] as unknown as Bindings;

describe("resolveObservability", () => {
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

  unit("no bind returns default logs", () => {
    const resolved = resolveObservability({}, []);
    expect(resolved.traces).toBeUndefined();
    expect(resolved.logs?.invocationLogs).toBe(true);
  });
});

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
  { timeout: 180_000 },
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
  { timeout: 180_000 },
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
  { timeout: 120_000 },
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
  { timeout: 300_000 },
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
      yield* expectUrlContains(
        `${worker.url}/fanout?id=warmup`,
        "native-did-fanout",
        { timeout: "180 seconds" },
      );

      // Several fan-out invocations in flight at once so fibers from
      // different requests interleave inside the isolate as well, plus one
      // request per remaining event path. Each request retries through
      // workers.dev propagation (a colo can still serve Cloudflare's error
      // page right after the warm-up succeeded elsewhere); a retried id just
      // produces one more independent trace.
      const ids = yield* Effect.sync(() => ({
        fanout: Array.from({ length: 3 }, () => globalThis.crypto.randomUUID()),
        exits: globalThis.crypto.randomUUID(),
        rpc: globalThis.crypto.randomUUID(),
        queue: globalThis.crypto.randomUUID(),
      }));
      const hit = (path: string, id: string, marker = id) =>
        expectUrlContains(`${worker.url}${path}?id=${id}`, marker, {
          timeout: "120 seconds",
        });
      yield* Effect.all(
        [
          ...ids.fanout.map((id) => hit("/fanout", id)),
          hit("/exits", ids.exits),
          hit("/rpc", ids.rpc, "native-did-rpc:do-ok"),
          hit("/enqueue", ids.queue),
          // Head sampling 1: every Effect span is sampled.
          expectUrlContains(
            `${worker.url}/sampled`,
            '"operation":true,"child":true',
            { timeout: "120 seconds" },
          ),
        ],
        { concurrency: "unbounded" },
      );

      // `request.id` is annotated on each root span, so a request's trace
      // is located via `$metadata.requestId`; wait until every expected
      // span of every request has been ingested.
      const expected = [
        ...ids.fanout.map((id) => ({
          root: "operation",
          id,
          names: FANOUT_SPANS,
        })),
        {
          root: "operation",
          id: ids.exits,
          names: ["operation", "failing.child", "interrupted.child"],
        },
        {
          root: "do.operation",
          id: ids.rpc,
          names: ["do.operation", "do.inner"],
        },
        {
          root: "queue.operation",
          id: ids.queue,
          names: ["queue.operation", "queue.inner"],
        },
      ];
      const ingested = (spans: SpanRow[]) =>
        expected.every((e) => {
          const trace = traceOf(spans, e.root, e.id);
          return (
            trace !== undefined &&
            e.names.every((name) =>
              trace.spans.some((s) => s.spanName === name),
            )
          );
        });
      // Ingestion latency varies from seconds to several minutes.
      const spans = yield* querySpans(accountId, worker.workerName).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: ingested,
          times: 60,
        }),
      );
      if (!ingested(spans)) {
        yield* Effect.logError(
          `native-tracing spans ingested so far: ${JSON.stringify(
            spans.map((s) => [s.requestId, s.spanName]),
          )}`,
        );
      }
      expect(ingested(spans)).toBe(true);

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
            (s) =>
              s.spanId === operation.parentSpanId && s.spanName !== "operation",
          ),
        ).toBe(true);
        for (const name of ["child.a", "child.b", "forked"]) {
          const branch = trace.span(name);
          expect(branch.parentSpanId).toBe(operation.spanId);
          expect(trace.span(`${name}.inner`).parentSpanId).toBe(branch.spanId);
          const platform = trace.spans.filter(
            (s) =>
              s.parentSpanId === branch.spanId &&
              !FANOUT_SPANS.includes(s.spanName ?? ""),
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
  { timeout: 480_000 },
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
              ConfigProvider.fromUnknown({ HEAD_SAMPLING_RATE: 0.01 }),
              currentConfig,
            ),
          ),
        );

      const settings = yield* workers.getScriptScriptAndVersionSetting({
        accountId,
        scriptName: worker.workerName,
      });
      expect(settings.observability?.traces?.enabled).toBe(true);
      expect(settings.observability?.traces?.headSamplingRate).toBe(0.01);

      // The runtime reports every invocation as traced (`span.isTraced` does
      // not carry the head-sampling decision — a rate of 0 behaves the same),
      // so Effect's `sampled` flag stays true and consistent parent → child.
      // Sampling is applied when Cloudflare ingests: of N invocations, only
      // ~1% persist.
      yield* expectUrlContains(`${worker.url}/sampled`, "native-did-sample", {
        timeout: "180 seconds",
      });
      const client = yield* HttpClient.HttpClient;
      const probe = client.get(`${worker.url}/sampled`).pipe(
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

      // Wait for ingestion to have caught up (the request's own `operation`
      // rows, or the platform's request spans, whichever lands first), then
      // bound the persisted count well under N. P(more than 15 of 100 at 1%)
      // is negligible.
      const persisted = yield* querySpans(accountId, worker.workerName).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (spans) => spans.length > 0,
          times: 36,
        }),
      );
      const sampled = persisted.filter((s) => s.spanName === "sampled.child");
      expect(sampled.length).toBeLessThanOrEqual(15);

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 300_000 },
);
