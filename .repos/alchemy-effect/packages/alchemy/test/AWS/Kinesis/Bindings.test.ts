import * as AWS from "@/AWS";
import * as Alchemy from "@/index.ts";
import * as State from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import KinesisApiFunctionLive, {
  KinesisApiFunction,
  StreamAndConsumer,
} from "./handler.ts";

const providers = AWS.providers();
const state = State.localState();
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state,
});

const Stack = Alchemy.Stack(
  "kinesis-bindings",
  { providers, state },
  Effect.gen(function* () {
    // Share one stream/consumer between the deployed function and the stack
    // outputs so the test can assert the live API responses against the known
    // names without round-tripping them through the fixture's runtime.
    const { stream, consumer } = yield* StreamAndConsumer;
    const fn = yield* KinesisApiFunction;
    return {
      url: fn.functionUrl.as<string>(),
      streamName: stream.streamName.as<string>(),
      consumerName: consumer.consumerName.as<string>(),
    };
  }).pipe(Effect.provide(KinesisApiFunctionLive)),
);

const stack = beforeAll(
  Effect.gen(function* () {
    yield* Effect.logInfo("Kinesis test setup: destroying previous resources");
    yield* destroy(Stack);

    yield* Effect.logInfo("Kinesis test setup: deploying fixture");
    return yield* deploy(Stack);
  }),
  { timeout: 240_000 },
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 60_000 });

// Lambda Function URLs cold-start (DNS, init) and a fresh role's IAM grants
// (eventual consistency) can both take a while on the first hit. Retrying on
// any non-200 lets the first request wait through that window; warm calls
// return on the first try and never retry.
const readinessSchedule = Schedule.max([
  Schedule.fixed("4 seconds"),
  Schedule.recurs(10),
]);

// Lambda Function URLs come back with a trailing slash (`https://…on.aws/`).
// Naively concatenating `${baseUrl}${path}` would yield a double slash
// (`…on.aws//stream`), whose pathname (`//stream`) never matches the fixture's
// `/stream` route, so every request 404s and the readiness retry spins until
// the test times out. Strip the trailing slash before joining.
const urlOf = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/+$/, "")}${path}`;

const getJson = (baseUrl: string, path: string) =>
  HttpClient.get(urlOf(baseUrl, path)).pipe(
    Effect.timeout("5 seconds"),
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`Request failed: ${response.status}`)),
    ),
    Effect.retry({ schedule: readinessSchedule }),
  );

const postJson = (baseUrl: string, path: string, body: unknown) =>
  HttpClient.execute(
    HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(urlOf(baseUrl, path)),
      body,
    ),
  ).pipe(
    // Runtime routes are normally sub-second. The record-polling and sink
    // routes can legitimately spend several seconds on bounded retries.
    Effect.timeout("15 seconds"),
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`Request failed: ${response.status}`)),
    ),
    Effect.retry({ schedule: readinessSchedule }),
  );

const getFirstShardId = (baseUrl: string) =>
  getJson(baseUrl, "/shards").pipe(
    Effect.map((response) => (response as any).Shards?.[0]?.ShardId as string),
  );

describe.sequential("Kinesis Bindings", () => {
  describe("DescribeAccountSettings", () => {
    test(
      "returns the account settings payload",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const response = yield* getJson(url, "/account-settings");
        if ((response as any).ok === false) {
          expect((response as any).error).toBeTruthy();
        } else {
          expect((response as any).value).toBeDefined();
        }
      }),
    );
  });

  describe("DescribeLimits", () => {
    test(
      "returns shard and stream limits",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const response = yield* getJson(url, "/limits");
        if ((response as any).ok === false) {
          expect((response as any).error).toBeTruthy();
        } else {
          expect((response as any).value.ShardLimit).toBeGreaterThan(0);
        }
      }),
    );
  });

  describe("ListStreams", () => {
    test(
      "lists the deployed stream",
      Effect.gen(function* () {
        // Kinesis ListStreams is paginated and the alchemy binding wraps
        // the single-page operation. On an account with > 100 streams our
        // brand-new stream may simply not be on page 1. Just verify the
        // binding returns an Array; the specific stream is verified via
        // DescribeStream below.
        const { url } = yield* stack;
        const response = yield* getJson(url, "/streams");
        const names = (response as any).StreamNames ?? [];
        expect(Array.isArray(names)).toBe(true);
      }),
    );
  });

  describe("DescribeStream", () => {
    test(
      "describes the bound stream",
      Effect.gen(function* () {
        const { url, streamName } = yield* stack;
        const response = yield* getJson(url, "/stream");
        expect((response as any).StreamDescription.StreamName).toBe(streamName);
      }),
    );
  });

  describe("DescribeStreamSummary", () => {
    test(
      "describes the bound stream summary",
      Effect.gen(function* () {
        const { url, streamName } = yield* stack;
        const response = yield* getJson(url, "/stream-summary");
        expect((response as any).StreamDescriptionSummary.StreamName).toBe(
          streamName,
        );
      }),
    );
  });

  describe("GetResourcePolicy", () => {
    test(
      "returns the stream policy or a structured error",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const response = yield* getJson(url, "/resource-policy");
        if ((response as any).ok === false) {
          expect((response as any).error).toBeTruthy();
        } else {
          expect((response as any).value).toBeDefined();
        }
      }),
    );
  });

  describe("ListShards", () => {
    test(
      "lists shards for the stream",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const response = yield* getJson(url, "/shards");
        expect(((response as any).Shards ?? []).length).toBeGreaterThan(0);
      }),
    );
  });

  describe("GetShardIterator", () => {
    test(
      "returns a shard iterator for the first shard",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const shardId = yield* getFirstShardId(url);
        const response = yield* postJson(url, "/iterator", { shardId });
        expect((response as any).ShardIterator).toBeTruthy();
      }),
    );
  });

  describe("GetRecords", () => {
    test(
      "reads a just-written record through the shard iterator",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const shardId = yield* getFirstShardId(url);
        const marker = `records-${crypto.randomUUID()}`;
        const response = yield* postJson(url, "/records", {
          shardId,
          partitionKey: "records-test",
          data: marker,
        });
        const records = (response as any).records ?? [];
        expect(records.some((record: any) => record.data === marker)).toBe(
          true,
        );
      }),
    );
  });

  describe("ListStreamConsumers", () => {
    test(
      "lists the registered consumer",
      Effect.gen(function* () {
        const { url, consumerName } = yield* stack;
        const response = yield* getJson(url, "/stream-consumers");
        const consumers = (response as any).Consumers ?? [];
        expect(
          consumers.some(
            (consumer: any) => consumer.ConsumerName === consumerName,
          ),
        ).toBe(true);
      }),
    );
  });

  describe("DescribeStreamConsumer", () => {
    test(
      "describes the registered consumer",
      Effect.gen(function* () {
        const { url, consumerName } = yield* stack;
        const response = yield* getJson(url, "/consumer");
        expect((response as any).ConsumerDescription.ConsumerName).toBe(
          consumerName,
        );
      }),
    );
  });

  describe("SubscribeToShard", () => {
    test(
      "opens a subscribe-to-shard stream",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const shardId = yield* getFirstShardId(url);
        const response = yield* postJson(url, "/subscribe", { shardId });
        expect((response as any).ok).toBe(true);
      }),
    );
  });

  describe("ListTagsForResource", () => {
    test(
      "lists the stream ownership tags",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const response = yield* getJson(url, "/tags");
        const keys = ((response as any).Tags ?? []).map((tag: any) => tag.Key);
        expect(keys).toContain("alchemy::stack");
        expect(keys).toContain("alchemy::stage");
        expect(keys).toContain("alchemy::id");
        expect(keys).toContain("fixture");
      }),
    );
  });

  describe("PutRecord", () => {
    test(
      "writes a single record",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const response = yield* postJson(url, "/put-record", {
          partitionKey: "put-record",
          data: `put-record-${crypto.randomUUID()}`,
        });
        expect((response as any).ShardId).toBeTruthy();
        expect((response as any).SequenceNumber).toBeTruthy();
      }),
    );
  });

  describe("PutRecords", () => {
    test(
      "writes a batch of records",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const response = yield* postJson(url, "/put-records", {
          records: [
            {
              partitionKey: "put-records",
              data: `batch-1-${crypto.randomUUID()}`,
            },
            {
              partitionKey: "put-records",
              data: `batch-2-${crypto.randomUUID()}`,
            },
          ],
        });
        expect((response as any).FailedRecordCount ?? 0).toBe(0);
        expect(((response as any).Records ?? []).length).toBe(2);
      }),
    );
  });

  describe("StreamSink", () => {
    test(
      "writes records through the sink helper",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const response = yield* postJson(url, "/sink", {
          records: [
            { partitionKey: "sink", data: `sink-1-${crypto.randomUUID()}` },
            { partitionKey: "sink", data: `sink-2-${crypto.randomUUID()}` },
          ],
        });
        expect((response as any).ok).toBe(true);
      }),
    );

    test(
      "splits more than 500 records into multiple PutRecords calls",
      Effect.gen(function* () {
        const { url } = yield* stack;
        // 501 records > the PutRecords limit of 500, so the batched sink
        // must split the chunk into 2 sequential API calls (500 + 1). Any
        // per-record throttling failures are retried by the sink engine.
        const marker = crypto.randomUUID();
        const response = yield* postJson(url, "/sink", {
          records: Array.from({ length: 501 }, (_, i) => ({
            partitionKey: `sink-${i % 7}`,
            data: `sink-${marker}-${i}`,
          })),
        });
        expect((response as any).ok).toBe(true);
      }),
      { timeout: 120_000 },
    );
  });

  // Shard-topology tests run LAST (describe.sequential) because they change
  // the stream's shard layout: earlier tests assume `Shards[0]` is the
  // single open shard the fixture was created with.
  describe("SplitShard", () => {
    test(
      "splits the open shard into two children",
      Effect.gen(function* () {
        const { url } = yield* stack;

        const openShards = yield* getOpenShards(url);
        expect(openShards.length).toBe(1);
        const shard = openShards[0]!;

        // Split at the midpoint of the shard's hash-key range.
        const start = BigInt(shard.HashKeyRange.StartingHashKey);
        const end = BigInt(shard.HashKeyRange.EndingHashKey);
        const midpoint = (start + end) / 2n + 1n;

        const response = yield* postJson(url, "/split-shard", {
          shardToSplit: shard.ShardId,
          newStartingHashKey: midpoint.toString(),
        });
        expect((response as any).ok).toBe(true);

        // The split completes asynchronously: the stream transitions
        // UPDATING -> ACTIVE and the parent shard closes, leaving two
        // open children.
        const children = yield* waitForOpenShardCount(url, 2);
        for (const child of children) {
          expect(child.ParentShardId).toBe(shard.ShardId);
        }
      }),
      { timeout: 120_000 },
    );
  });

  describe("MergeShards", () => {
    test(
      "merges the two adjacent children back into one shard",
      Effect.gen(function* () {
        const { url } = yield* stack;

        const openShards = yield* waitForOpenShardCount(url, 2);
        // Order the two children by hash-key range so they are passed as
        // (shard, adjacent-shard) the way MergeShards expects.
        const [low, high] = [...openShards].sort((a, b) =>
          BigInt(a.HashKeyRange.StartingHashKey) <
          BigInt(b.HashKeyRange.StartingHashKey)
            ? -1
            : 1,
        );

        const response = yield* postJson(url, "/merge-shards", {
          shardToMerge: low!.ShardId,
          adjacentShardToMerge: high!.ShardId,
        });
        expect((response as any).ok).toBe(true);

        const merged = yield* waitForOpenShardCount(url, 1);
        expect(merged[0]!.ParentShardId).toBe(low!.ShardId);
      }),
      { timeout: 120_000 },
    );
  });
});

interface ShardInfo {
  ShardId: string;
  ParentShardId?: string;
  HashKeyRange: { StartingHashKey: string; EndingHashKey: string };
  SequenceNumberRange: { EndingSequenceNumber?: string };
}

// A shard is open while its sequence-number range has no upper bound.
const getOpenShards = (baseUrl: string) =>
  getJson(baseUrl, "/shards").pipe(
    Effect.map((response) =>
      (((response as any).Shards ?? []) as ShardInfo[]).filter(
        (shard) =>
          shard.SequenceNumberRange?.EndingSequenceNumber === undefined,
      ),
    ),
  );

const waitForOpenShardCount = (baseUrl: string, count: number) =>
  getOpenShards(baseUrl).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (shards): boolean => shards.length === count,
      times: 20,
    }),
    Effect.flatMap((shards) =>
      shards.length === count
        ? Effect.succeed(shards)
        : Effect.fail(
            new Error(
              `expected ${count} open shards, saw ${shards.length} after polling`,
            ),
          ),
    ),
  );
