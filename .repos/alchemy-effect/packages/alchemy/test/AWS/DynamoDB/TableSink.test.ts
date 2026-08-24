import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { TableSinkFunction, TableSinkFunctionLive } from "./sink-handler";

const { test } = Test.make({ providers: AWS.providers() });

class FunctionNotReady extends Data.TaggedError("FunctionNotReady") {}

class TableStillExists extends Data.TaggedError("TableStillExists") {}

// Out-of-band proof that the trailing destroy deleted the fixture table.
const assertTableIsDeleted = Effect.fn(function* (tableName: string) {
  yield* DynamoDB.describeTable({
    TableName: tableName,
  }).pipe(
    Effect.flatMap(() => Effect.fail(new TableStillExists())),
    Effect.retry({
      while: (e) => e._tag === "TableStillExists",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(30),
      ]),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );
});

class ItemCountMismatch extends Data.TaggedError("ItemCountMismatch")<{
  readonly expected: number;
  readonly actual: number;
}> {}

const waitForFunctionReady = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? (response.json as Effect.Effect<{ tableName: string }>)
        : Effect.fail(new FunctionNotReady()),
    ),
    // A freshly-deployed function can briefly serve a 200 before its captured
    // env vars (the table name) have finished propagating, so treat a missing
    // tableName as "not ready yet" and keep polling.
    Effect.flatMap((json: any) =>
      typeof json?.tableName === "string"
        ? Effect.succeed({ tableName: json.tableName as string })
        : Effect.fail(new FunctionNotReady()),
    ),
    Effect.retry({
      while: (error) => error._tag === "FunctionNotReady",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(75),
      ]),
    }),
  );

/**
 * Out-of-band read: strongly-consistent query for every sk under `pk`.
 * Retries briefly in case a cold re-init served the POST a moment before
 * the last batch call settled.
 */
const waitForSortKeys = Effect.fn(function* (
  tableName: string,
  pk: string,
  expected: number,
) {
  return yield* Effect.gen(function* () {
    const result = yield* DynamoDB.query({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: pk } },
      ConsistentRead: true,
    });
    const sortKeys = (result.Items ?? []).flatMap((item) =>
      item.sk?.S !== undefined ? [item.sk.S] : [],
    );
    if (sortKeys.length !== expected) {
      return yield* Effect.fail(
        new ItemCountMismatch({ expected, actual: sortKeys.length }),
      );
    }
    return sortKeys;
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ItemCountMismatch",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(15),
      ]),
    }),
  );
});

test.provider(
  "TableSink streams put and delete requests through a deployed Lambda",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const apiFunction = yield* stack.deploy(
        TableSinkFunction.pipe(Effect.provide(TableSinkFunctionLive)),
      );
      const baseUrl = apiFunction.functionUrl!.replace(/\/+$/, "");

      const { tableName } = yield* waitForFunctionReady(`${baseUrl}/ready`);

      const postSink = (body: {
        pk: string;
        puts?: string[];
        deletes?: string[];
      }) =>
        Effect.gen(function* () {
          const response = yield* HttpClient.post(`${baseUrl}/sink`, {
            body: yield* HttpBody.json(body),
          });
          if (response.status !== 200) {
            return yield* Effect.fail(new FunctionNotReady());
          }
          return (yield* response.json) as { ok: boolean; count: number };
        }).pipe(
          Effect.retry({
            while: (error) => error._tag === "FunctionNotReady",
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(30),
            ]),
          }),
        );

      const pk = `sink#${crypto.randomUUID()}`;
      // 60 put requests > the BatchWriteItem limit of 25, so the batched sink
      // must split the chunk into 3 sequential API calls (25 + 25 + 10).
      const items = Array.from(
        { length: 60 },
        (_, i) => `item-${String(i).padStart(3, "0")}`,
      );

      const putResponse = yield* postSink({ pk, puts: items });
      expect(putResponse.ok).toBe(true);
      expect(putResponse.count).toBe(items.length);

      // Out-of-band read via distilled proves every entry landed.
      const landed = yield* waitForSortKeys(tableName, pk, items.length);
      expect([...landed].sort()).toEqual(items);

      // Stream DeleteRequests through the same sink for the first half.
      const toDelete = items.slice(0, 30);
      const deleteResponse = yield* postSink({ pk, deletes: toDelete });
      expect(deleteResponse.ok).toBe(true);
      expect(deleteResponse.count).toBe(toDelete.length);

      const remaining = yield* waitForSortKeys(
        tableName,
        pk,
        items.length - toDelete.length,
      );
      expect([...remaining].sort()).toEqual(items.slice(30));

      yield* stack.destroy();
      yield* assertTableIsDeleted(tableName);
    }),
  { timeout: 240_000 },
);
