import * as AWS from "@/AWS";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Shared infrastructure for the BusSink fixture:
 * - a custom event bus the sink publishes to
 * - an SQS queue routed from the bus (via `toQueue`) so the test can observe
 *   delivered events out-of-band via `sqs.receiveMessage`.
 */
export class BusSinkInfra extends Context.Service<
  BusSinkInfra,
  {
    bus: AWS.EventBridge.EventBus;
    queue: AWS.SQS.Queue;
  }
>()("EventBridgeBusSinkInfra") {}

export const BusSinkInfraLive = Layer.effect(
  BusSinkInfra,
  Effect.gen(function* () {
    const bus = yield* AWS.EventBridge.EventBus("BusSinkBus", {
      name: "alchemy-test-eb-bus-sink",
    });
    // The delivery policy is a plain prop (not a `toQueue` binding) so the
    // Queue never depends on the Rule — Queue<->Rule would otherwise form a
    // cycle neither resource can precreate out of. A queue policy only ever
    // governs the queue it is attached to, so `Resource: "*"` is safely
    // scoped for this fixture.
    const queue = yield* AWS.SQS.Queue("BusSinkQueue", {
      policy: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "events.amazonaws.com" },
            Action: "sqs:SendMessage",
            Resource: "*",
          },
        ],
      },
    });
    // Route every sink-published event to the queue for out-of-band
    // observation.
    yield* AWS.EventBridge.Rule("BusSinkRoute", {
      eventBusName: bus.eventBusName,
      eventPattern: { source: ["alchemy.test.bussink"] },
      targets: [{ Id: "BusSinkQueueTarget", Arn: queue.queueArn as any }],
    });
    return { bus, queue };
  }),
);

export class BusSinkFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "BusSinkFunction",
) {}

export const BusSinkFunctionLive = BusSinkFunction.make(
  {
    main: import.meta.url,
    url: true,
    // The sink's bounded partial-failure retry can sleep up to ~6s, which
    // exceeds Lambda's 3s default timeout (see PATTERNS §7).
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const { bus, queue } = yield* BusSinkInfra;
    const sink = yield* AWS.EventBridge.BusSink(bus);
    const queueUrl = yield* queue.queueUrl;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "GET" && pathname === "/ready") {
          return yield* HttpServerResponse.json({
            ok: true,
            queueUrl: yield* queueUrl,
          });
        }

        if (request.method === "POST" && pathname === "/sink") {
          const body = (yield* request.json) as {
            markers: string[];
            includeMalformed?: boolean;
          };

          const entries: AWS.EventBridge.BusSinkEntry[] = body.markers.map(
            (marker) => ({
              Source: "alchemy.test.bussink",
              DetailType: "BusSinkEvent",
              Detail: JSON.stringify({ marker }),
            }),
          );
          if (body.includeMalformed) {
            // Detail must be valid JSON. EventBridge rejects this entry
            // per-entry (ErrorCode: MalformedDetail) without failing the
            // batch — the sink must drop it and deliver the rest.
            entries.splice(1, 0, {
              Source: "alchemy.test.bussink",
              DetailType: "BusSinkEvent",
              Detail: "{ this is not json",
            });
          }

          yield* Stream.fromIterable(entries).pipe(Stream.run(sink));

          return yield* HttpServerResponse.json({
            ok: true,
            count: entries.length,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            HttpServerResponse.text(`Internal server error: ${String(error)}`, {
              status: 500,
            }),
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        Layer.mergeAll(BusSinkInfraLive, AWS.EventBridge.BusSinkHttp),
        Layer.mergeAll(AWS.EventBridge.PutEventsHttp),
      ),
    ),
  ),
);

export default BusSinkFunctionLive;
