import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as Kinesis from "@distilled.cloud/aws/kinesis";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import KinesisStreamFunctionLive, {
  KinesisStreamFunction,
} from "./stream-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

describe.sequential("AWS.Kinesis.StreamEventSource", () => {
  test.provider(
    "processes real Kinesis records through Lambda",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const streamFunction = yield* stack.deploy(
          KinesisStreamFunction.pipe(Effect.provide(KinesisStreamFunctionLive)),
        );

        const functionUrl = streamFunction.functionUrl!;

        const { streamName, streamArn } = yield* HttpClient.get(
          functionUrl,
        ).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? (response.json as Effect.Effect<{
                  streamName: string;
                  streamArn: string;
                }>)
              : Effect.fail(
                  new FunctionNotReady(
                    `Function not ready: ${response.status}`,
                  ),
                ),
          ),
          Effect.flatMap((body) =>
            body.streamName && body.streamArn
              ? Effect.succeed(body)
              : Effect.fail(
                  new FunctionNotReady(
                    "Function returned empty stream identifiers",
                  ),
                ),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.fixed("1 seconds"),
              Schedule.recurs(60),
            ]),
          }),
        );

        yield* waitForEventSourceMappingEnabled(
          streamFunction.functionName,
          streamArn,
        );
        yield* Effect.sleep("10 seconds");

        yield* Kinesis.putRecord({
          StreamName: streamName,
          PartitionKey: "stream-event-source",
          Data: new TextEncoder().encode("payload"),
        });
        yield* Effect.sleep("5 seconds");

        const mapping = yield* waitForEventSourceMappingEnabled(
          streamFunction.functionName,
          streamArn,
        );
        expect(mapping.State).toEqual("Enabled");

        yield* stack.destroy();
      }),
    { timeout: 240_000 },
  );
});

const waitForEventSourceMappingEnabled = Effect.fn(function* (
  functionName: string,
  eventSourceArn: string,
) {
  return yield* Lambda.listEventSourceMappings({
    FunctionName: functionName,
    EventSourceArn: eventSourceArn,
  }).pipe(
    Effect.flatMap((result) => {
      const mapping = result.EventSourceMappings?.[0];
      if (!mapping || mapping.State !== "Enabled") {
        return Effect.fail(new EventSourceMappingNotReady());
      }
      return Effect.succeed(mapping);
    }),
    Effect.retry({
      while: (error) => error._tag === "EventSourceMappingNotReady",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );
});

class EventSourceMappingNotReady extends Data.TaggedError(
  "EventSourceMappingNotReady",
) {}

class FunctionNotReady extends Data.TaggedError("FunctionNotReady")<{
  message: string;
}> {
  constructor(message: string) {
    super({ message });
  }
}
