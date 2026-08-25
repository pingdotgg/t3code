import * as DataExchange from "@/AWS/DataExchange";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

const CSV = "date,price\n2026-07-14,42.5\n";
const KEY = "prices.csv";

export class DataExchangeTestFunction extends Lambda.Function<Lambda.Function>()(
  "DataExchangeTestFunction",
) {}

export default DataExchangeTestFunction.make(
  {
    main,
    url: true,
    // The /import route runs a full import job (create → start → poll to
    // COMPLETED), which takes tens of seconds.
    timeout: Duration.minutes(2),
  },
  Effect.gen(function* () {
    // The owned data set + draft revision the scoped bindings are bound to,
    // and the bucket the import job reads from.
    const dataSet = yield* DataExchange.DataSet("BindingDataSet", {
      description: "alchemy dataexchange bindings fixture",
    });
    const revision = yield* DataExchange.Revision("BindingRevision", {
      dataSetId: dataSet.dataSetId,
      comment: "bindings fixture revision",
    });
    const bucket = yield* S3.Bucket("BindingBucket", { forceDestroy: true });

    // Event source: subscribe the host to Data Exchange revision events.
    // The deploy proves the EventBridge rule + invoke permission wiring.
    yield* DataExchange.consumeDataSetEvents(
      { kinds: ["revision-published", "revision-revoked"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(`dataexchange event: ${event["detail-type"]}`),
        ),
    );

    // Data-set-scoped bindings.
    const getDataSet = yield* DataExchange.GetDataSet(dataSet);
    const listDataSetRevisions =
      yield* DataExchange.ListDataSetRevisions(dataSet);
    const sendDataSetNotification =
      yield* DataExchange.SendDataSetNotification(dataSet);
    // Revision-scoped bindings.
    const getRevision = yield* DataExchange.GetRevision(revision);
    const listRevisionAssets = yield* DataExchange.ListRevisionAssets(revision);
    const getAsset = yield* DataExchange.GetAsset(revision);
    // Account-scoped bindings.
    const listDataSets = yield* DataExchange.ListDataSets();
    const createJob = yield* DataExchange.CreateJob();
    const startJob = yield* DataExchange.StartJob();
    const getJob = yield* DataExchange.GetJob();
    const listJobs = yield* DataExchange.ListJobs();
    const listDataGrants = yield* DataExchange.ListDataGrants();
    const listReceivedDataGrants = yield* DataExchange.ListReceivedDataGrants();
    const listEventActions = yield* DataExchange.ListEventActions();
    // S3 access for the import job: the Lambda writes the source object and
    // the Data Exchange import job reads it with the caller's permissions.
    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);

    const bound = {
      getDataSet,
      listDataSetRevisions,
      sendDataSetNotification,
      getRevision,
      listRevisionAssets,
      getAsset,
      listDataSets,
      createJob,
      startJob,
      getJob,
      listJobs,
      listDataGrants,
      listReceivedDataGrants,
      listEventActions,
      putObject,
      getObject,
    };

    const BucketName = yield* bucket.bucketName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // Data-set-scoped read: the DataSetId is injected from the binding.
        if (request.method === "GET" && pathname === "/data-set") {
          const detail = yield* getDataSet();
          return yield* HttpServerResponse.json({
            id: detail.Id,
            name: detail.Name,
            assetType: detail.AssetType,
            origin: detail.Origin,
          });
        }

        if (request.method === "GET" && pathname === "/revisions") {
          const { Revisions } = yield* listDataSetRevisions();
          return yield* HttpServerResponse.json({
            ids: (Revisions ?? []).map((entry) => entry.Id),
          });
        }

        // Revision-scoped read: DataSetId + RevisionId are injected.
        if (request.method === "GET" && pathname === "/revision") {
          const detail = yield* getRevision();
          return yield* HttpServerResponse.json({
            id: detail.Id,
            finalized: detail.Finalized ?? false,
          });
        }

        if (request.method === "GET" && pathname === "/assets") {
          const { Assets } = yield* listRevisionAssets();
          return yield* HttpServerResponse.json({
            count: (Assets ?? []).length,
          });
        }

        // Account-level list, filtered down to owned data sets.
        if (request.method === "GET" && pathname === "/data-sets") {
          const { DataSets } = yield* listDataSets({ Origin: "OWNED" });
          return yield* HttpServerResponse.json({
            ids: (DataSets ?? []).map((entry) => entry.Id),
          });
        }

        // Provider-generated notification about the bound data set.
        if (request.method === "POST" && pathname === "/notify") {
          const result = yield* sendDataSetNotification({
            Type: "DATA_UPDATE",
            Comment: "alchemy bindings fixture notification",
          }).pipe(Effect.result);
          return yield* HttpServerResponse.json({
            ok: result._tag === "Success",
            error: result._tag === "Failure" ? result.failure._tag : undefined,
            message:
              result._tag === "Failure" ? String(result.failure) : undefined,
          });
        }

        // Full import flow: put a CSV in S3, import it into the bound
        // revision via a job, poll the job to COMPLETED, then read the
        // imported asset back through the revision-scoped bindings. Typed
        // failures are surfaced as JSON so the test can report the cause.
        if (request.method === "POST" && pathname === "/import") {
          const flow = Effect.gen(function* () {
            yield* putObject({ Key: KEY, Body: CSV, ContentType: "text/csv" });

            const dataSetDetail = yield* getDataSet();
            const revisionDetail = yield* getRevision();
            const job = yield* createJob({
              Type: "IMPORT_ASSETS_FROM_S3",
              Details: {
                ImportAssetsFromS3: {
                  DataSetId: dataSetDetail.Id!,
                  RevisionId: revisionDetail.Id!,
                  AssetSources: [{ Bucket: yield* BucketName, Key: KEY }],
                },
              },
            });
            yield* startJob({ JobId: job.Id! });
            const done = yield* getJob({ JobId: job.Id! }).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("2 seconds"),
                until: (j): boolean =>
                  j.State === "COMPLETED" ||
                  j.State === "ERROR" ||
                  j.State === "CANCELLED",
                times: 40,
              }),
            );

            const { Assets } = yield* listRevisionAssets();
            const assetId = (Assets ?? [])[0]?.Id;
            const asset =
              assetId !== undefined
                ? yield* getAsset({ AssetId: assetId })
                : undefined;
            return {
              jobState: done.State,
              jobErrors: done.Errors,
              assetCount: (Assets ?? []).length,
              assetName: asset?.Name,
            };
          });
          const result = yield* flow.pipe(Effect.result);
          return result._tag === "Success"
            ? yield* HttpServerResponse.json(result.success)
            : yield* HttpServerResponse.json({
                error: result.failure._tag,
                message: String(result.failure),
              });
        }

        if (request.method === "GET" && pathname === "/jobs") {
          const dataSetDetail = yield* getDataSet();
          const { Jobs } = yield* listJobs({ DataSetId: dataSetDetail.Id! });
          return yield* HttpServerResponse.json({
            states: (Jobs ?? []).map((entry) => entry.State),
          });
        }

        // Account-level data grant + event action enumerations.
        if (request.method === "GET" && pathname === "/grants") {
          const sent = yield* listDataGrants();
          const received = yield* listReceivedDataGrants();
          return yield* HttpServerResponse.json({
            sent: (sent.DataGrantSummaries ?? []).length,
            received: (received.DataGrantSummaries ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/event-actions") {
          const { EventActions } = yield* listEventActions();
          return yield* HttpServerResponse.json({
            count: (EventActions ?? []).length,
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
      Layer.mergeAll(
        Lambda.EventSource,
        DataExchange.GetDataSetHttp,
        DataExchange.ListDataSetRevisionsHttp,
        DataExchange.SendDataSetNotificationHttp,
        DataExchange.GetRevisionHttp,
        DataExchange.ListRevisionAssetsHttp,
        DataExchange.GetAssetHttp,
        DataExchange.ListDataSetsHttp,
        DataExchange.CreateJobHttp,
        DataExchange.StartJobHttp,
        DataExchange.GetJobHttp,
        DataExchange.ListJobsHttp,
        DataExchange.ListDataGrantsHttp,
        DataExchange.ListReceivedDataGrantsHttp,
        DataExchange.ListEventActionsHttp,
        S3.PutObjectHttp,
        S3.GetObjectHttp,
      ),
    ),
  ),
);
