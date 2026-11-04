import { fileURLToPath } from "node:url";
import * as AWS from "@alchemy.run/aws";
import { EventSourceMapping } from "@alchemy.run/aws/Lambda";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as DynamoDBStreams from "@distilled.cloud/aws/dynamodb-streams";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { driftActions, driftOf, repairDrift, waitForDrift } from "../drift.ts";
import EventSourceMappingFunctionLive, {
  EventSourceMappingFunction,
} from "./fixtures/event-source-mapping-handler.ts";
import {
  EventSourceMappingReplaceFunction,
  FifoQueueLive,
  StandardQueueLive,
} from "./fixtures/event-source-mapping-replace-handler.ts";
import {
  EventSourceMappingTableFunction,
  makeTableFunction,
  type TableFunctionOptions,
} from "./fixtures/event-source-mapping-table-handler.ts";
import EventSourceMappingVisibilityFunctionLive, {
  EventSourceMappingVisibilityFunction,
} from "./fixtures/event-source-mapping-visibility-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

const timeoutHandlerPath = fileURLToPath(new URL("./timeout-handler.ts", import.meta.url));

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
        EventSourceMappingFunction.pipe(Effect.provide(EventSourceMappingFunctionLive)),
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
          Effect.fail(new Error(`Event source mapping ${mine.uuid} still exists`)),
        ),
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        Effect.retry({
          schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
        }),
      );
      yield* Lambda.getFunction({ FunctionName: fn.functionName }).pipe(
        Effect.flatMap(() => Effect.fail(new Error(`Function ${fn.functionName} still exists`))),
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        Effect.retry({
          schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
        }),
      );
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:lambda", "provider:aws:sqs", "live"],
    timeout: 240_000,
  },
);

// Lambda runs a Function for `timeout + timeoutMargin`, so a 30-second Function
// on a queue left at SQS's 30-second visibility timeout is refused by AWS. The
// mapping reports it as a typed error that names the setting to change.
test.provider(
  "a queue whose visibility timeout is below the function's Lambda timeout fails with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(
          EventSourceMappingVisibilityFunction.pipe(
            Effect.provide(EventSourceMappingVisibilityFunctionLive),
          ),
        )
        .pipe(Effect.flip);
      expect(error._tag).toBe("QueueVisibilityTimeoutBelowFunctionTimeout");
      expect(error.message).toContain("31 seconds");
      expect(error.message).toContain("visibilityTimeout");

      yield* stack.destroy();
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:lambda", "provider:aws:sqs", "live"],
    timeout: 240_000,
  },
);

// Switching the queue between standard and FIFO replaces it in the same deploy
// that updates the mapping, so the queue's ARN is unresolved when the mapping
// is diffed. AWS cannot move a mapping to another source, so the mapping must
// be recreated on the new queue.
test.provider(
  "moves the mapping to a replaced queue",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const mappingsOf = (functionName: string) =>
        Lambda.listEventSourceMappings({ FunctionName: functionName }).pipe(
          Effect.map((page) => page.EventSourceMappings ?? []),
        );

      const standard = yield* stack.deploy(
        EventSourceMappingReplaceFunction.pipe(Effect.provide(StandardQueueLive)),
      );
      const [before] = yield* mappingsOf(standard.functionName);
      expect(before?.EventSourceArn?.endsWith(".fifo")).toBe(false);

      const fifo = yield* stack.deploy(
        EventSourceMappingReplaceFunction.pipe(Effect.provide(FifoQueueLive)),
      );
      const after = yield* mappingsOf(fifo.functionName);

      expect(after.length).toBe(1);
      expect(after[0]!.EventSourceArn?.endsWith(".fifo")).toBe(true);
      expect(after[0]!.UUID).not.toEqual(before!.UUID);

      yield* stack.destroy();
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:lambda", "provider:aws:sqs", "live"],
    timeout: 240_000,
  },
);

// Retagging a Table updates it in place, so its stream ARN is unresolved when
// the mapping is diffed but does not change. The mapping must stay in place:
// recreating it would skip (LATEST) or replay (TRIM_HORIZON) stream records.
test.provider(
  "keeps the mapping when its table is updated in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const mappingsOf = (functionName: string) =>
        Lambda.listEventSourceMappings({ FunctionName: functionName }).pipe(
          Effect.map((page) => page.EventSourceMappings ?? []),
        );

      const v1 = yield* stack.deploy(
        EventSourceMappingTableFunction.pipe(
          Effect.provide(makeTableFunction({ tags: { version: "1" } })),
        ),
      );
      const before = yield* mappingsOf(v1.functionName);
      expect(before.length).toBe(1);

      const v2 = yield* stack.deploy(
        EventSourceMappingTableFunction.pipe(
          Effect.provide(makeTableFunction({ tags: { version: "2" } })),
        ),
      );
      const after = yield* mappingsOf(v2.functionName);

      expect(after.length).toBe(1);
      expect(after[0]!.UUID).toEqual(before[0]!.UUID);
      expect(after[0]!.EventSourceArn).toEqual(before[0]!.EventSourceArn);

      yield* stack.destroy();
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:lambda", "provider:aws:dynamodb", "live"],
    timeout: 240_000,
  },
);

const deployTableFunction = (stack: Test.ScratchStack, options: TableFunctionOptions) =>
  stack.deploy(EventSourceMappingTableFunction.pipe(Effect.provide(makeTableFunction(options))));

const tableMappingsOf = (functionName: string) =>
  Lambda.listEventSourceMappings({ FunctionName: functionName }).pipe(
    Effect.map((page) => page.EventSourceMappings ?? []),
  );

const streamStatusOf = (streamArn: string) =>
  DynamoDBStreams.describeStream({ StreamArn: streamArn }).pipe(
    Effect.map((stream) => stream.StreamDescription?.StreamStatus),
  );

// `startingPosition` cannot be updated in place, so changing it replaces the
// mapping. The replacement reads the same stream as the mapping it replaces.
test.provider(
  "replaces the mapping when its startingPosition changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const v1 = yield* deployTableFunction(stack, { startingPosition: "LATEST" });
      const before = yield* tableMappingsOf(v1.functionName);
      expect(before.length).toBe(1);

      const v2 = yield* deployTableFunction(stack, { startingPosition: "TRIM_HORIZON" });
      const after = yield* tableMappingsOf(v2.functionName);

      expect(after.length).toBe(1);
      expect(after[0]!.StartingPosition).toBe("TRIM_HORIZON");
      expect(after[0]!.EventSourceArn).toEqual(before[0]!.EventSourceArn);

      yield* stack.destroy();
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:lambda", "provider:aws:dynamodb", "live"],
    timeout: 240_000,
  },
);

// Updating the Table in the same deploy leaves its stream ARN unresolved when
// the mapping is diffed; the new `startingPosition` must still be applied.
test.provider(
  "applies a new startingPosition while its table is updated",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const v1 = yield* deployTableFunction(stack, {
        tags: { version: "1" },
        startingPosition: "LATEST",
      });
      expect((yield* tableMappingsOf(v1.functionName)).length).toBe(1);

      const v2 = yield* deployTableFunction(stack, {
        tags: { version: "2" },
        startingPosition: "TRIM_HORIZON",
      });
      const after = yield* tableMappingsOf(v2.functionName);

      expect(after.length).toBe(1);
      expect(after[0]!.StartingPosition).toBe("TRIM_HORIZON");

      yield* stack.destroy();
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:lambda", "provider:aws:dynamodb", "live"],
    timeout: 240_000,
  },
);

// Changing the stream view type re-creates the Table's stream while the Table
// itself is updated in place, so the mapping must move to the new stream.
test.provider(
  "moves the mapping when its table's stream is re-created",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const v1 = yield* deployTableFunction(stack, { streamViewType: "NEW_AND_OLD_IMAGES" });
      const [before] = yield* tableMappingsOf(v1.functionName);

      const v2 = yield* deployTableFunction(stack, { streamViewType: "KEYS_ONLY" });
      const after = yield* tableMappingsOf(v2.functionName);

      expect(after.length).toBe(1);
      expect(after[0]!.EventSourceArn).not.toEqual(before!.EventSourceArn);
      expect(yield* streamStatusOf(after[0]!.EventSourceArn!)).toBe("ENABLED");

      yield* stack.destroy();
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:lambda", "provider:aws:dynamodb", "live"],
    timeout: 240_000,
  },
);

// Changing the partition key replaces the Table, and with it the stream.
test.provider(
  "moves the mapping when its table is replaced",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const v1 = yield* deployTableFunction(stack, { partitionKey: "pk" });
      const [before] = yield* tableMappingsOf(v1.functionName);

      const v2 = yield* deployTableFunction(stack, { partitionKey: "id" });
      const after = yield* tableMappingsOf(v2.functionName);

      expect(after.length).toBe(1);
      expect(after[0]!.EventSourceArn).not.toEqual(before!.EventSourceArn);
      expect(yield* streamStatusOf(after[0]!.EventSourceArn!)).toBe("ENABLED");

      yield* stack.destroy();
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:lambda", "provider:aws:dynamodb", "live"],
    timeout: 240_000,
  },
);

// #2688: EventSourceMapping and Permission had no `read`, so drift skipped
// them: a consumer disabled or reconfigured out of band, or a removed invoke
// permission, went unnoticed.
test.provider(
  "drift detects and repairs a disabled mapping and a removed permission",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { fn, mapping } = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* AWS.SQS.Queue("DriftMappingQueue", {});
          const fn = yield* AWS.Lambda.Function("DriftMappingFn", {
            main: timeoutHandlerPath,
            handler: "handler",
            isExternal: true,
            functionUrl: false,
          });
          yield* fn.bind("AllowQueuePoll", {
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
                Resource: [queue.queueArn],
              },
            ],
          });
          const mapping = yield* EventSourceMapping("DriftMapping", {
            functionName: fn.functionName,
            eventSourceArn: queue.queueArn,
            batchSize: 5,
          });
          yield* AWS.Lambda.Permission("DriftPermission", {
            action: "lambda:InvokeFunction",
            functionName: fn.functionName,
            principal: "events.amazonaws.com",
          });
          return { fn, mapping };
        }),
      );
      const actions = yield* driftActions(stack);
      expect(Object.values(actions).every((action) => action === "unchanged")).toBe(true);

      yield* Lambda.updateEventSourceMapping({
        UUID: mapping.uuid,
        Enabled: false,
        BatchSize: 9,
      }).pipe(
        Effect.retry({
          while: (e) => e._tag === "ResourceInUseException",
          schedule: Schedule.spaced("2 seconds"),
          times: 15,
        }),
      );
      const permission = yield* driftOf(stack, "DriftPermission");
      yield* Lambda.removePermission({
        FunctionName: fn.functionName,
        StatementId: permission!.attr!.statementId,
      });

      const drifted = yield* waitForDrift(stack, "DriftMapping", "drifted");
      expect(drifted?.attr?.configuration).toMatchObject({ enabled: false, batchSize: 9 });
      expect((yield* waitForDrift(stack, "DriftPermission", "missing"))?.action).toBe("missing");

      const repaired = yield* repairDrift(stack);
      expect(repaired.resources.DriftMapping?.action).toBe("repaired");
      expect(repaired.resources.DriftPermission?.action).toBe("recreated");
      const after = yield* driftActions(stack);
      expect(Object.values(after).every((action) => action === "unchanged")).toBe(true);
      const restored = yield* Lambda.getEventSourceMapping({ UUID: mapping.uuid });
      expect(restored.State).toBe("Enabled");
      expect(restored.BatchSize).toBe(5);

      yield* stack.destroy();
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  {
    tags: ["provider:aws", "provider:aws:lambda", "provider:aws:sqs", "live"],
    timeout: 300_000,
  },
);
