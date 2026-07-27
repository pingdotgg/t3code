import * as AWS from "@/AWS";
import { EventSourceMapping } from "@/AWS/Lambda";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import EventSourceMappingFunctionLive, {
  EventSourceMappingFunction,
} from "./fixtures/event-source-mapping-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (AWS account/region-scoped collection): deploy a
// minimal Lambda Function + SQS Queue + EventSourceMapping (wired via the
// `consumeQueueMessages(queue, ...)` event source), resolve the provider from
// context with the typed `Provider.findProvider(EventSourceMapping)`, call
// `list()`, and assert the deployed mapping appears in the exhaustively
// paginated result.
test.provider(
  "list enumerates the deployed event source mapping",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fn = yield* stack.deploy(
        EventSourceMappingFunction.pipe(
          Effect.provide(EventSourceMappingFunctionLive),
        ),
      );

      const provider = yield* Provider.findProvider(EventSourceMapping);
      const all = yield* provider.list();

      expect(all.length).toBeGreaterThan(0);
      expect(all.some((m) => m.functionArn === fn.functionArn)).toBe(true);

      const mine = all.find((m) => m.functionArn === fn.functionArn)!;
      expect(mine.uuid).toBeTruthy();
      expect(mine.eventSourceMappingArn).toContain("event-source-mapping");
      expect(mine.state).toBeTruthy();

      yield* stack.destroy();

      // Out-of-band proof the destroy removed both the mapping and the host
      // function from the cloud (bounded retry for delete propagation).
      yield* Lambda.getEventSourceMapping({ UUID: mine.uuid }).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new Error(`Event source mapping ${mine.uuid} still exists`),
          ),
        ),
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.exponential(500),
            Schedule.recurs(8),
          ]),
        }),
      );
      yield* Lambda.getFunction({ FunctionName: fn.functionName }).pipe(
        Effect.flatMap(() =>
          Effect.fail(new Error(`Function ${fn.functionName} still exists`)),
        ),
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.exponential(500),
            Schedule.recurs(8),
          ]),
        }),
      );
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { timeout: 240_000 },
);
