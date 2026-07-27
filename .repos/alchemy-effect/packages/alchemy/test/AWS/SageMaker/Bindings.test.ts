import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import SageMakerTestFunctionLive, { SageMakerTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SageMakerBindings");

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionArn: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry only transient 5xx (cold re-inits under parallel-suite load);
// genuine 4xx/assertion failures surface immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

const postJson = (path: string, body: unknown) =>
  send(
    HttpClientRequest.post(`${baseUrl}${path}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
    ),
  ).pipe(Effect.flatMap((r) => r.json));

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe("SageMaker FeatureStore Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("SageMaker bindings: destroying previous stack");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("SageMaker bindings: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SageMakerTestFunction;
        }).pipe(Effect.provide(SageMakerTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      yield* Effect.logInfo(
        `SageMaker bindings: probing readiness at ${baseUrl}/health`,
      );
      yield* HttpClient.get(`${baseUrl}/health`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 480_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 300_000 });

  describe("binding registration", () => {
    test.provider("all six capabilities initialize in the runtime", () =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound.sort()).toEqual(
          [
            "batchGetRecord",
            "batchWriteRecord",
            "deleteRecord",
            "getRecord",
            "listRecords",
            "putRecord",
          ].sort(),
        );
      }),
    );
  });

  describe("PutRecord", () => {
    test.provider(
      "writes a record to the online store",
      () =>
        Effect.gen(function* () {
          const body = (yield* postJson("/put-record", {
            userId: "user-put-1",
            clicks: 7,
          })) as { success: boolean };
          expect(body.success).toBe(true);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetRecord", () => {
    test.provider(
      "reads back a written record",
      () =>
        Effect.gen(function* () {
          yield* postJson("/put-record", {
            userId: "user-roundtrip-1",
            clicks: 42,
          });

          const body = (yield* getJson(
            "/get-record?userId=user-roundtrip-1",
          )) as {
            record: { FeatureName?: string; ValueAsString?: string }[];
          };
          const byName = Object.fromEntries(
            body.record.map((f) => [f.FeatureName, f.ValueAsString]),
          );
          expect(byName.user_id).toBe("user-roundtrip-1");
          expect(byName.clicks).toBe("42");
        }),
      { timeout: 60_000 },
    );

    test.provider(
      "returns an empty record for an unknown identifier",
      () =>
        Effect.gen(function* () {
          const body = (yield* getJson(
            "/get-record?userId=user-never-written",
          )) as { record: unknown[] };
          expect(body.record).toEqual([]);
        }),
      { timeout: 60_000 },
    );
  });

  describe("DeleteRecord", () => {
    test.provider(
      "soft-deletes a written record (GetRecord no longer returns it)",
      () =>
        Effect.gen(function* () {
          yield* postJson("/put-record", {
            userId: "user-delete-1",
            clicks: 1,
          });
          yield* postJson("/delete-record", { userId: "user-delete-1" });

          // Online-store deletes are read-after-write consistent in practice;
          // allow a short bounded window regardless.
          const body = yield* getJson("/get-record?userId=user-delete-1").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (b): boolean =>
                (b as { record: unknown[] }).record.length === 0,
              times: 8,
            }),
          );
          expect((body as { record: unknown[] }).record).toEqual([]);
        }),
      { timeout: 60_000 },
    );
  });

  describe("BatchWriteRecord + BatchGetRecord", () => {
    test.provider(
      "bulk-writes records and reads them back in one batch",
      () =>
        Effect.gen(function* () {
          const write = (yield* postJson("/batch-write-record", {
            records: [
              { userId: "user-batch-1", clicks: 11 },
              { userId: "user-batch-2", clicks: 22 },
            ],
          })) as { errors: unknown[]; unprocessed: unknown[] };
          expect(write.errors).toEqual([]);
          expect(write.unprocessed).toEqual([]);

          const read = (yield* postJson("/batch-get-record", {
            userIds: ["user-batch-1", "user-batch-2", "user-batch-missing"],
          })) as {
            records: {
              userId: string;
              record: { FeatureName?: string; ValueAsString?: string }[];
            }[];
            errors: unknown[];
          };
          expect(read.errors).toEqual([]);
          const byUser = Object.fromEntries(
            read.records.map((r) => [
              r.userId,
              Object.fromEntries(
                r.record.map((f) => [f.FeatureName, f.ValueAsString]),
              ),
            ]),
          );
          expect(byUser["user-batch-1"]?.clicks).toBe("11");
          expect(byUser["user-batch-2"]?.clicks).toBe("22");
          expect(byUser["user-batch-missing"]).toBeUndefined();
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListRecords", () => {
    test.provider(
      "lists the identifiers of stored records",
      () =>
        Effect.gen(function* () {
          yield* postJson("/put-record", { userId: "user-list-1", clicks: 3 });

          const body = yield* getJson("/list-records").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (b): boolean =>
                (b as { identifiers: string[] }).identifiers.includes(
                  "user-list-1",
                ),
              times: 8,
            }),
          );
          expect((body as { identifiers: string[] }).identifiers).toContain(
            "user-list-1",
          );
        }),
      { timeout: 60_000 },
    );
  });

  describe("consumeSageMakerEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      () =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeSageMakerEvents
          // must have materialized as a rule on the default bus with the
          // Lambda as target.
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
        }),
    );
  });
});
