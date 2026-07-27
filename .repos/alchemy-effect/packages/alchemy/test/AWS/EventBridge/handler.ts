import * as AWS from "@/AWS";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class EventBridgeTestFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "EventBridgeTestFunction",
) {}

/**
 * Shared infrastructure for the EventBridge bindings fixture:
 * - a custom event bus (PutEvents + consumeBusEvents against a named bus)
 * - one SQS sink queue per consume loop (custom bus + default bus) so the
 *   test can observe delivered events out-of-band via `sqs.receiveMessage`
 * - a target-less rule on the custom bus for the Enable/DisableRule toggles
 * - an archive on the custom bus for the replay bindings
 */
export class BusAndQueues extends Context.Service<
  BusAndQueues,
  {
    bus: AWS.EventBridge.EventBus;
    customQueue: AWS.SQS.Queue;
    defaultQueue: AWS.SQS.Queue;
    toggleRule: AWS.EventBridge.Rule;
    archive: AWS.EventBridge.Archive;
  }
>()("EventBridgeBusAndQueues") {}

export const BusAndQueuesLive = Layer.effect(
  BusAndQueues,
  Effect.gen(function* () {
    const bus = yield* AWS.EventBridge.EventBus("TestBus", {
      name: "alchemy-test-eb-bindings",
      // A crashed run can leak event-source rules whose state rows are
      // gone; without forceDestroy those orphans block deleteEventBus
      // with EventBusHasRules forever.
      forceDestroy: true,
    });
    const customQueue = yield* AWS.SQS.Queue("CustomBusSink");
    const defaultQueue = yield* AWS.SQS.Queue("DefaultBusSink");
    const toggleRule = yield* AWS.EventBridge.Rule("ToggleRule", {
      name: "alchemy-test-eb-toggle",
      eventBusName: bus.eventBusName,
      eventPattern: { source: ["alchemy.test.toggle"] },
    });
    const archive = yield* AWS.EventBridge.Archive("TestArchive", {
      name: "alchemy-test-eb-archive",
      eventSourceArn: bus.eventBusArn,
      retention: "1 day",
    });
    return { bus, customQueue, defaultQueue, toggleRule, archive };
  }),
);

export default EventBridgeTestFunction.make(
  {
    main: import.meta.url,
    url: true,
  },
  Effect.gen(function* () {
    const { bus, customQueue, defaultQueue, toggleRule, archive } =
      yield* BusAndQueues;

    const putEventsCustom = yield* AWS.EventBridge.PutEvents(bus);
    const putEventsDefault = yield* AWS.EventBridge.PutEvents();
    const customSink = yield* AWS.SQS.QueueSink(customQueue);
    const defaultSink = yield* AWS.SQS.QueueSink(defaultQueue);
    const enableRule = yield* AWS.EventBridge.EnableRule(toggleRule);
    const disableRule = yield* AWS.EventBridge.DisableRule(toggleRule);
    const describeToggleRule = yield* AWS.EventBridge.DescribeRule(toggleRule);
    const listRuleNamesByTarget =
      yield* AWS.EventBridge.ListRuleNamesByTarget();
    const startReplay = yield* AWS.EventBridge.StartReplay(archive);
    const describeReplay = yield* AWS.EventBridge.DescribeReplay();
    const cancelReplay = yield* AWS.EventBridge.CancelReplay();
    const listReplays = yield* AWS.EventBridge.ListReplays();
    const describeCustomBus = yield* AWS.EventBridge.DescribeEventBus(bus);
    const listEventBuses = yield* AWS.EventBridge.ListEventBuses();
    const listCustomBusRules = yield* AWS.EventBridge.ListRules(bus);
    const listToggleRuleTargets =
      yield* AWS.EventBridge.ListTargetsByRule(toggleRule);
    const testEventPattern = yield* AWS.EventBridge.TestEventPattern();

    // Consume loop on the CUSTOM bus: matching events are forwarded to the
    // custom sink queue where the test observes them out-of-band.
    yield* AWS.EventBridge.consumeBusEvents(
      bus,
      { source: ["alchemy.test.custom"] },
      (events: Stream.Stream<AWS.EventBridge.EventRecord>) =>
        events.pipe(
          Stream.map((event) => ({
            MessageBody: JSON.stringify({
              source: event.source,
              detailType: event["detail-type"],
              detail: event.detail,
            }),
          })),
          Stream.run(customSink),
          Effect.orDie,
        ),
    );

    // Consume loop on the DEFAULT bus (no bus argument).
    yield* AWS.EventBridge.consumeBusEvents(
      { source: ["alchemy.test.default"] },
      (events: Stream.Stream<AWS.EventBridge.EventRecord>) =>
        events.pipe(
          Stream.map((event) => ({
            MessageBody: JSON.stringify({
              source: event.source,
              detailType: event["detail-type"],
              detail: event.detail,
            }),
          })),
          Stream.run(defaultSink),
          Effect.orDie,
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/publish-custom") {
          const body = (yield* request.json) as unknown as { marker: string };
          const result = yield* putEventsCustom({
            Entries: [
              {
                Source: "alchemy.test.custom",
                DetailType: "TestEvent",
                Detail: JSON.stringify({ marker: body.marker }),
              },
            ],
          });
          return yield* HttpServerResponse.json({
            failedEntryCount: result.FailedEntryCount ?? 0,
            entries: result.Entries ?? [],
          });
        }

        if (request.method === "POST" && pathname === "/publish-default") {
          const body = (yield* request.json) as unknown as { marker: string };
          const result = yield* putEventsDefault({
            Entries: [
              {
                Source: "alchemy.test.default",
                DetailType: "TestEvent",
                Detail: JSON.stringify({ marker: body.marker }),
              },
            ],
          });
          return yield* HttpServerResponse.json({
            failedEntryCount: result.FailedEntryCount ?? 0,
            entries: result.Entries ?? [],
          });
        }

        if (request.method === "POST" && pathname === "/rule-toggle") {
          // Disable, observe, re-enable, observe — exercises DisableRule,
          // DescribeRule, and EnableRule end-to-end.
          yield* disableRule();
          const afterDisable = (yield* describeToggleRule()).State;
          yield* enableRule();
          const afterEnable = (yield* describeToggleRule()).State;
          return yield* HttpServerResponse.json({ afterDisable, afterEnable });
        }

        if (request.method === "POST" && pathname === "/rule-names-by-target") {
          const body = (yield* request.json) as unknown as {
            targetArn: string;
          };
          const result = yield* listRuleNamesByTarget({
            TargetArn: body.targetArn,
          });
          return yield* HttpServerResponse.json({
            ruleNames: result.RuleNames ?? [],
          });
        }

        if (request.method === "GET" && pathname === "/bus-info") {
          // DescribeEventBus scoped to the bound custom bus.
          const info = yield* describeCustomBus();
          return yield* HttpServerResponse.json({
            name: info.Name,
            arn: info.Arn,
          });
        }

        if (request.method === "GET" && pathname === "/event-buses") {
          // ListEventBuses is account-level; the default bus always exists.
          const result = yield* listEventBuses();
          return yield* HttpServerResponse.json({
            names: (result.EventBuses ?? []).flatMap((b) =>
              b.Name ? [b.Name] : [],
            ),
          });
        }

        if (request.method === "GET" && pathname === "/rules") {
          // ListRules scoped to the bound custom bus — sees the toggle rule
          // and the consume-loop rule.
          const result = yield* listCustomBusRules();
          return yield* HttpServerResponse.json({
            ruleNames: (result.Rules ?? []).flatMap((r) =>
              r.Name ? [r.Name] : [],
            ),
          });
        }

        if (request.method === "GET" && pathname === "/targets-by-rule") {
          // ListTargetsByRule scoped to the (target-less) toggle rule.
          const result = yield* listToggleRuleTargets();
          return yield* HttpServerResponse.json({
            targetCount: (result.Targets ?? []).length,
          });
        }

        if (request.method === "POST" && pathname === "/test-pattern") {
          const body = (yield* request.json) as unknown as { source: string };
          const event = JSON.stringify({
            id: "1",
            source: body.source,
            "detail-type": "TestEvent",
            account: "123456789012",
            region: "us-east-1",
            time: new Date().toISOString(),
            detail: {},
          });
          const pattern = JSON.stringify({ source: ["alchemy.test.pattern"] });
          const matching = yield* testEventPattern({
            EventPattern: pattern,
            Event: event,
          });
          return yield* HttpServerResponse.json({
            matches: matching.Result ?? false,
          });
        }

        if (request.method === "GET" && pathname === "/replays") {
          const result = yield* listReplays();
          return yield* HttpServerResponse.json({
            count: (result.Replays ?? []).length,
          });
        }

        if (request.method === "POST" && pathname === "/replay") {
          const replayName = "alchemy-test-eb-replay";
          // Replay an empty window from the recent past onto the archive's
          // source bus (the binding's default destination). Replays cannot
          // be deleted, so re-runs hit ResourceAlreadyExistsException —
          // treated as success and observed via DescribeReplay below.
          const now = Date.now();
          const started = yield* Effect.result(
            startReplay({
              ReplayName: replayName,
              EventStartTime: new Date(now - 10 * 60 * 1000),
              EventEndTime: new Date(now - 5 * 60 * 1000),
            }).pipe(
              Effect.catchTag("ResourceAlreadyExistsException", () =>
                Effect.succeed(undefined),
              ),
            ),
          );
          if (Result.isFailure(started)) {
            return yield* HttpServerResponse.json(
              {
                error: "startReplay",
                failure: JSON.stringify(started.failure),
              },
              { status: 400 },
            );
          }
          const described = yield* Effect.result(
            describeReplay({ ReplayName: replayName }),
          );
          if (Result.isFailure(described)) {
            return yield* HttpServerResponse.json(
              {
                error: "describeReplay",
                failure: JSON.stringify(described.failure),
              },
              { status: 400 },
            );
          }
          // Cancelling a finished replay fails with the typed
          // IllegalStatusException — either outcome proves the binding.
          const cancel = yield* Effect.result(
            cancelReplay({ ReplayName: replayName }).pipe(
              Effect.map(() => "cancelled" as const),
              Effect.catchTag("IllegalStatusException", () =>
                Effect.succeed("not-cancellable" as const),
              ),
            ),
          );
          if (Result.isFailure(cancel)) {
            return yield* HttpServerResponse.json(
              {
                error: "cancelReplay",
                failure: JSON.stringify(cancel.failure),
              },
              { status: 400 },
            );
          }
          return yield* HttpServerResponse.json({
            state: described.success.State,
            cancel: cancel.success,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(
          AWS.Lambda.EventSource,
          AWS.EventBridge.PutEventsHttp,
          AWS.EventBridge.EnableRuleHttp,
          AWS.EventBridge.DisableRuleHttp,
          AWS.EventBridge.DescribeRuleHttp,
          AWS.EventBridge.ListRuleNamesByTargetHttp,
          AWS.EventBridge.StartReplayHttp,
          AWS.EventBridge.DescribeReplayHttp,
          AWS.EventBridge.CancelReplayHttp,
          AWS.EventBridge.ListReplaysHttp,
          AWS.EventBridge.DescribeEventBusHttp,
          AWS.EventBridge.ListEventBusesHttp,
          AWS.EventBridge.ListRulesHttp,
          AWS.EventBridge.ListTargetsByRuleHttp,
          AWS.EventBridge.TestEventPatternHttp,
          AWS.SQS.QueueSinkHttp,
          BusAndQueuesLive,
        ),
        Layer.mergeAll(AWS.SQS.SendMessageBatchHttp),
      ),
    ),
  ),
);
