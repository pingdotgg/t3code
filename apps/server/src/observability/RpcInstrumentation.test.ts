import { assert, describe, it } from "@effect/vitest";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  ScheduledTaskError,
  ScheduledTaskId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as TestClock from "effect/testing/TestClock";

import { RPC_REQUIRED_SCOPES } from "../auth/RpcAuthorization.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { RpcInstrumentation, rpcInstrumentationLayer } from "./RpcInstrumentation.ts";

type WsRpcMethod = keyof typeof RPC_REQUIRED_SCOPES;

/** The server group narrowed to `tags`, so a test only implements the handlers it calls. */
const groupOf = <const Tags extends ReadonlyArray<WsRpcMethod>>(...tags: Tags) =>
  WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<WsRpcMethod, Tags[number]> =>
        !(tags as ReadonlyArray<string>).includes(tag),
    ),
  ).middleware(RpcInstrumentation);

/** The middleware ws.ts installs for a connection with `scopes`. */
const connectionMiddleware = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  Layer.merge(RpcAuthorization.layer(scopes), rpcInstrumentationLayer);
const readOnlyConnection = connectionMiddleware([AuthOrchestrationReadScope]);
const taskId = ScheduledTaskId.make("scheduled-task:instrumented");
const rpcSpanDefaults = { "rpc.transport": "websocket", "rpc.system": "effect-rpc" };

/** Runs a test with a fresh metric registry and a tracer that keeps every span it ends. */
const withTelemetry = <A, E, R>(
  test: (ended: ReadonlyArray<Tracer.NativeSpan>) => Effect.Effect<A, E, R>,
) => {
  const ended: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        ended.push(span);
      };
      return span;
    },
  });
  return test(ended).pipe(
    Effect.scoped,
    Effect.withTracer(tracer),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  );
};

const rpcSpans = (ended: ReadonlyArray<Tracer.NativeSpan>) =>
  ended.filter((span) => span.name.startsWith("ws.rpc."));

// RpcTest keeps Effect's own RpcServer/RpcClient spans, which ws.ts turns off with
// `disableTracing: true`. Everything else comes from the middleware or the handlers.
const appSpans = (ended: ReadonlyArray<Tracer.NativeSpan>) =>
  ended.filter((span) => !/^Rpc(Server|Client)\./.test(span.name));

const exitTag = (span: Tracer.NativeSpan | undefined) =>
  span?.status._tag === "Ended" ? span.status.exit._tag : undefined;

const parentSpanId = (span: Tracer.NativeSpan | undefined) =>
  span?.parent._tag === "Some" ? span.parent.value.spanId : undefined;

const requestCount = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  method: string,
  outcome: string,
) =>
  snapshots.find(
    (snapshot): snapshot is Extract<Metric.Metric.Snapshot, { readonly type: "Counter" }> =>
      snapshot.type === "Counter" &&
      snapshot.id === "t3_rpc_requests_total" &&
      snapshot.attributes?.["method"] === method &&
      snapshot.attributes?.["outcome"] === outcome,
  )?.state;

const requestDuration = (snapshots: ReadonlyArray<Metric.Metric.Snapshot>, method: string) =>
  snapshots.find(
    (snapshot): snapshot is Extract<Metric.Metric.Snapshot, { readonly type: "Histogram" }> =>
      snapshot.type === "Histogram" &&
      snapshot.id === "t3_rpc_request_duration" &&
      snapshot.attributes?.["method"] === method,
  )?.state;

describe("WS RPC instrumentation middleware", () => {
  it.effect("records one span and request metric per call, including rejected calls", () =>
    withTelemetry((ended) =>
      Effect.gen(function* () {
        const group = groupOf(
          WS_METHODS.serverProbe,
          WS_METHODS.scheduledTasksList,
          WS_METHODS.serverRetryResourceTelemetry,
          WS_METHODS.pullRequestsSubscribeRefreshes,
          WS_METHODS.scheduledTasksSubscribe,
          WS_METHODS.serverGetSettings,
        );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.serverProbe, () =>
                Effect.succeed({}).pipe(Effect.withSpan("serverProbe.child")),
              ),
              group.toLayerHandler(WS_METHODS.scheduledTasksList, () =>
                Effect.annotateCurrentSpan({ "scheduled_task.id": taskId }).pipe(
                  Effect.andThen(new ScheduledTaskError({ message: "List failed." })),
                ),
              ),
              group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
                Effect.die("authorization let a rejected call through"),
              ),
              group.toLayerHandler(WS_METHODS.pullRequestsSubscribeRefreshes, () =>
                Stream.make(1, 2),
              ),
              group.toLayerHandler(WS_METHODS.scheduledTasksSubscribe, () =>
                Stream.concat(
                  Stream.make({ tasks: [] }),
                  Stream.fail(new ScheduledTaskError({ message: "Subscription failed." })),
                ),
              ),
              group.toLayerHandler(WS_METHODS.serverGetSettings, () => Effect.die("broken")),
              readOnlyConnection,
            ),
          ),
        );

        assert.deepStrictEqual(yield* client[WS_METHODS.serverProbe]({}), {});
        const listError = yield* client[WS_METHODS.scheduledTasksList]({}).pipe(Effect.flip);
        assert.equal(listError._tag, "ScheduledTaskError");
        // Retrying telemetry needs operate scope, so the handler must not run.
        const rejection = yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(
          Effect.flip,
        );
        assert.equal(rejection._tag, "EnvironmentAuthorizationError");
        const refreshes = yield* Stream.runCollect(
          client[WS_METHODS.pullRequestsSubscribeRefreshes]({}),
        );
        assert.deepStrictEqual(Array.from(refreshes), [1, 2]);
        const subscribeError = yield* Stream.runDrain(
          client[WS_METHODS.scheduledTasksSubscribe]({}),
        ).pipe(Effect.flip);
        assert.equal(subscribeError._tag, "ScheduledTaskError");
        const settingsExit = yield* Effect.exit(client[WS_METHODS.serverGetSettings]({}));
        assert.isTrue(Exit.hasDies(settingsExit));

        assert.deepStrictEqual(
          rpcSpans(ended).map((span) => [span.name, Object.fromEntries(span.attributes)]),
          [
            [
              "ws.rpc.server.probe",
              {
                ...rpcSpanDefaults,
                "rpc.method": WS_METHODS.serverProbe,
                "rpc.aggregate": "server",
              },
            ],
            [
              "ws.rpc.scheduledTasks.list",
              {
                ...rpcSpanDefaults,
                "rpc.method": WS_METHODS.scheduledTasksList,
                "rpc.aggregate": "scheduledTasks",
                "scheduled_task.id": taskId,
              },
            ],
            [
              "ws.rpc.server.retryResourceTelemetry",
              {
                ...rpcSpanDefaults,
                "rpc.method": WS_METHODS.serverRetryResourceTelemetry,
                "rpc.aggregate": "server",
              },
            ],
            [
              "ws.rpc.pullRequests.subscribeRefreshes",
              {
                ...rpcSpanDefaults,
                "rpc.method": WS_METHODS.pullRequestsSubscribeRefreshes,
                "rpc.aggregate": "pull-requests",
              },
            ],
            [
              "ws.rpc.scheduledTasks.subscribe",
              {
                ...rpcSpanDefaults,
                "rpc.method": WS_METHODS.scheduledTasksSubscribe,
                "rpc.aggregate": "scheduledTasks",
              },
            ],
            [
              "ws.rpc.server.getSettings",
              {
                ...rpcSpanDefaults,
                "rpc.method": WS_METHODS.serverGetSettings,
                "rpc.aggregate": "server",
              },
            ],
          ],
        );
        assert.deepStrictEqual(rpcSpans(ended).map(exitTag), [
          "Success",
          "Failure",
          "Failure",
          "Success",
          "Failure",
          "Failure",
        ]);
        const probeSpan = rpcSpans(ended)[0];
        const child = ended.find((span) => span.name === "serverProbe.child");
        assert.equal(parentSpanId(child), probeSpan?.spanId);

        const snapshots = yield* Metric.snapshot;
        assert.deepStrictEqual(
          [
            requestCount(snapshots, WS_METHODS.serverProbe, "success"),
            requestCount(snapshots, WS_METHODS.scheduledTasksList, "failure"),
            requestCount(snapshots, WS_METHODS.serverRetryResourceTelemetry, "failure"),
            requestCount(snapshots, WS_METHODS.pullRequestsSubscribeRefreshes, "success"),
            requestCount(snapshots, WS_METHODS.scheduledTasksSubscribe, "failure"),
            requestCount(snapshots, WS_METHODS.serverGetSettings, "failure"),
          ].map((state) => state?.count),
          [1, 1, 1, 1, 1, 1],
        );
        for (const method of group.requests.keys()) {
          assert.equal(requestDuration(snapshots, method)?.count, 1);
        }
      }),
    ),
  );

  it.effect("keeps a stream's span and duration open until the subscription is interrupted", () =>
    withTelemetry((ended) =>
      Effect.gen(function* () {
        const waiting = yield* Deferred.make<void>();
        const group = groupOf(WS_METHODS.pullRequestsSubscribeRefreshes);
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.pullRequestsSubscribeRefreshes, () =>
                Stream.concat(
                  Stream.make(1),
                  Stream.fromEffect(
                    Deferred.succeed(waiting, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.withSpan("refreshes.wait"),
                    ),
                  ),
                ),
              ),
              readOnlyConnection,
            ),
          ),
        );

        // Wall and monotonic time disagree before the call starts, so a duration that mixes
        // the two clocks is caught.
        yield* TestClock.adjust(Duration.seconds(1));
        yield* TestClock.setTime(0);
        const consumer = yield* Stream.runDrain(
          client[WS_METHODS.pullRequestsSubscribeRefreshes]({}),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        yield* TestClock.adjust(Duration.millis(250));
        // A backward wall-clock correction must not shorten the measured duration.
        yield* TestClock.setTime(0);
        assert.deepStrictEqual(appSpans(ended), []);

        // The client waits for the server to stop the call, which ends the RPC span.
        yield* Fiber.interrupt(consumer);

        const [rpcSpan] = rpcSpans(ended);
        assert.equal(rpcSpan?.name, "ws.rpc.pullRequests.subscribeRefreshes");
        assert.equal(exitTag(rpcSpan), "Failure");
        const waitSpan = ended.find((span) => span.name === "refreshes.wait");
        assert.equal(parentSpanId(waitSpan), rpcSpan?.spanId);

        const snapshots = yield* Metric.snapshot;
        assert.equal(
          requestCount(snapshots, WS_METHODS.pullRequestsSubscribeRefreshes, "interrupt")?.count,
          1,
        );
        const duration = requestDuration(snapshots, WS_METHODS.pullRequestsSubscribeRefreshes);
        assert.equal(duration?.count, 1);
        assert.equal(duration?.sum, 250);
      }),
    ),
  );

  it.effect("records metrics but no spans for methods with tracing disabled", () =>
    withTelemetry((ended) =>
      Effect.gen(function* () {
        const group = groupOf(WS_METHODS.serverSignalProcess);
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.serverSignalProcess, (input) =>
                Effect.succeed({
                  pid: input.pid,
                  signal: input.signal,
                  signaled: true,
                  message: Option.none(),
                }).pipe(Effect.withSpan("signalProcess.child")),
              ),
              connectionMiddleware([AuthOrchestrationReadScope, AuthEnvironmentMaintainScope]),
            ),
          ),
        );

        const input = { pid: 4242, startTimeMs: 0, signal: "SIGINT" } as const;
        assert.equal((yield* client[WS_METHODS.serverSignalProcess](input)).signaled, true);

        assert.deepStrictEqual(appSpans(ended), []);
        const snapshots = yield* Metric.snapshot;
        assert.equal(requestCount(snapshots, WS_METHODS.serverSignalProcess, "success")?.count, 1);
      }),
    ),
  );
});
