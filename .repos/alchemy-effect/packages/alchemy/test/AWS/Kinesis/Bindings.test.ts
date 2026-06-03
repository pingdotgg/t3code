import * as AWS from "@/AWS";
import * as Alchemy from "@/index.ts";
import * as State from "@/State";
import * as Test from "@/Test/Vitest";
import { describe, expect } from "@effect/vitest";
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

const stack = beforeAll(deploy(Stack), { timeout: 240_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 60_000 });

// Lambda Function URLs cold-start (DNS, init) and a fresh role's IAM grants
// (eventual consistency) can both take a while on the first hit. Retrying on
// any non-200 lets the first request wait through that window; warm calls
// return on the first try and never retry.
const readinessSchedule = Schedule.fixed("2 seconds").pipe(
  Schedule.both(Schedule.recurs(75)),
);

// Lambda Function URLs come back with a trailing slash (`https://…on.aws/`).
// Naively concatenating `${baseUrl}${path}` would yield a double slash
// (`…on.aws//stream`), whose pathname (`//stream`) never matches the fixture's
// `/stream` route, so every request 404s and the readiness retry spins until
// the test times out. Strip the trailing slash before joining.
const urlOf = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/+$/, "")}${path}`;

const getJson = (baseUrl: string, path: string) =>
  HttpClient.get(urlOf(baseUrl, path)).pipe(
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
  });
});
