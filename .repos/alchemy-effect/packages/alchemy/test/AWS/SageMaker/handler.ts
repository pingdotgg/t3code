import * as Lambda from "@/AWS/Lambda";
import * as SageMaker from "@/AWS/SageMaker";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class SageMakerTestFunction extends Lambda.Function<Lambda.Function>()(
  "SageMakerTestFunction",
) {}

export default SageMakerTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const featureGroup = yield* SageMaker.FeatureGroup("BindingsFeatures", {
      recordIdentifierFeatureName: "user_id",
      eventTimeFeatureName: "event_time",
      featureDefinitions: [
        { FeatureName: "user_id", FeatureType: "String" },
        { FeatureName: "event_time", FeatureType: "String" },
        { FeatureName: "clicks", FeatureType: "Integral" },
      ],
      onlineStoreConfig: { EnableOnlineStore: true },
    });

    // Event source: subscribe the host to SageMaker feature-group state
    // changes. The deploy proves the EventBridge rule + invoke permission
    // wiring.
    yield* SageMaker.consumeSageMakerEvents(
      { kinds: ["feature-group"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `feature group ${event.detail.FeatureGroupName} -> ${event.detail.FeatureGroupStatus}`,
          ),
        ),
    );

    const putRecord = yield* SageMaker.PutRecord(featureGroup);
    const getRecord = yield* SageMaker.GetRecord(featureGroup);
    const deleteRecord = yield* SageMaker.DeleteRecord(featureGroup);
    const batchGetRecord = yield* SageMaker.BatchGetRecord(featureGroup);
    const batchWriteRecord = yield* SageMaker.BatchWriteRecord(featureGroup);
    const listRecords = yield* SageMaker.ListRecords(featureGroup);

    const bound = {
      putRecord,
      getRecord,
      deleteRecord,
      batchGetRecord,
      batchWriteRecord,
      listRecords,
    };

    const record = (userId: string, clicks: number) => [
      { FeatureName: "user_id", ValueAsString: userId },
      { FeatureName: "event_time", ValueAsString: new Date().toISOString() },
      { FeatureName: "clicks", ValueAsString: String(clicks) },
    ];

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({ bound: Object.keys(bound) });
        }

        if (request.method === "POST" && pathname === "/put-record") {
          const body = (yield* request.json) as unknown as {
            userId: string;
            clicks: number;
          };
          yield* putRecord({ Record: record(body.userId, body.clicks) });
          return yield* HttpServerResponse.json({ success: true });
        }

        if (request.method === "GET" && pathname === "/get-record") {
          const userId = url.searchParams.get("userId") ?? "";
          const result = yield* getRecord({
            RecordIdentifierValueAsString: userId,
          });
          return yield* HttpServerResponse.json({
            record: result.Record ?? [],
          });
        }

        if (request.method === "POST" && pathname === "/delete-record") {
          const body = (yield* request.json) as unknown as { userId: string };
          yield* deleteRecord({
            RecordIdentifierValueAsString: body.userId,
            EventTime: new Date().toISOString(),
          });
          return yield* HttpServerResponse.json({ success: true });
        }

        if (request.method === "POST" && pathname === "/batch-write-record") {
          const body = (yield* request.json) as unknown as {
            records: { userId: string; clicks: number }[];
          };
          const result = yield* batchWriteRecord({
            Entries: body.records.map((r) => ({
              Record: record(r.userId, r.clicks),
            })),
          });
          return yield* HttpServerResponse.json({
            errors: result.Errors ?? [],
            unprocessed: result.UnprocessedEntries ?? [],
          });
        }

        if (request.method === "POST" && pathname === "/batch-get-record") {
          const body = (yield* request.json) as unknown as {
            userIds: string[];
          };
          const result = yield* batchGetRecord({
            RecordIdentifiersValueAsString: body.userIds,
          });
          return yield* HttpServerResponse.json({
            records: (result.Records ?? []).map((r) => ({
              userId: r.RecordIdentifierValueAsString,
              record: r.Record ?? [],
            })),
            errors: result.Errors ?? [],
          });
        }

        if (request.method === "GET" && pathname === "/list-records") {
          const result = yield* listRecords({ MaxResults: 100 });
          return yield* HttpServerResponse.json({
            identifiers: result.RecordIdentifiers ?? [],
          });
        }

        if (request.method === "GET" && pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        SageMaker.PutRecordHttp,
        SageMaker.GetRecordHttp,
        SageMaker.DeleteRecordHttp,
        SageMaker.BatchGetRecordHttp,
        SageMaker.BatchWriteRecordHttp,
        SageMaker.ListRecordsHttp,
      ),
    ),
  ),
);
