import * as Forecast from "@/AWS/Forecast";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class ForecastTestFunction extends Lambda.Function<Lambda.Function>()(
  "ForecastTestFunction",
) {}

/**
 * Account-level binding fixture: Amazon Forecast is closed to new customers,
 * so no Forecast object is ever created. Every route drives an ARN-addressed
 * operation against a well-formed-but-nonexistent ARN (passed by the test as
 * a query parameter) and returns the typed error tag the service answers
 * with — `ResourceNotFoundException` in a grandfathered account,
 * `AccessDeniedException` (the new-customer closure) otherwise. Either way
 * the route proves the deploy-time IAM bind, the runtime call plumbing, and
 * the typed error decode inside the Lambda.
 */
export default ForecastTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const createDatasetImportJob = yield* Forecast.CreateDatasetImportJob();
    const describeDatasetImportJob = yield* Forecast.DescribeDatasetImportJob();
    const createAutoPredictor = yield* Forecast.CreateAutoPredictor();
    const describeAutoPredictor = yield* Forecast.DescribeAutoPredictor();
    const getAccuracyMetrics = yield* Forecast.GetAccuracyMetrics();
    const createForecast = yield* Forecast.CreateForecast();
    const describeForecast = yield* Forecast.DescribeForecast();
    const stopResource = yield* Forecast.StopResource();
    const resumeResource = yield* Forecast.ResumeResource();
    const queryForecast = yield* Forecast.QueryForecast();
    const queryWhatIfForecast = yield* Forecast.QueryWhatIfForecast();
    const createForecastExportJob = yield* Forecast.CreateForecastExportJob();
    const describeForecastExportJob =
      yield* Forecast.DescribeForecastExportJob();
    const createWhatIfAnalysis = yield* Forecast.CreateWhatIfAnalysis();
    const describeWhatIfAnalysis = yield* Forecast.DescribeWhatIfAnalysis();
    const createWhatIfForecast = yield* Forecast.CreateWhatIfForecast();
    const describeWhatIfForecast = yield* Forecast.DescribeWhatIfForecast();
    const createWhatIfForecastExport =
      yield* Forecast.CreateWhatIfForecastExport();
    const describeWhatIfForecastExport =
      yield* Forecast.DescribeWhatIfForecastExport();
    const deleteResourceTree = yield* Forecast.DeleteResourceTree();

    const bound = {
      createDatasetImportJob,
      describeDatasetImportJob,
      createAutoPredictor,
      describeAutoPredictor,
      getAccuracyMetrics,
      createForecast,
      describeForecast,
      stopResource,
      resumeResource,
      queryForecast,
      queryWhatIfForecast,
      createForecastExportJob,
      describeForecastExportJob,
      createWhatIfAnalysis,
      describeWhatIfAnalysis,
      createWhatIfForecast,
      describeWhatIfForecast,
      createWhatIfForecastExport,
      describeWhatIfForecastExport,
      deleteResourceTree,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const arn = url.searchParams.get("arn") ?? "";

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/import-probe") {
          const tag = yield* describeDatasetImportJob({
            DatasetImportJobArn: arn,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/predictor-probe") {
          const tag = yield* describeAutoPredictor({
            PredictorArn: arn,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/accuracy-probe") {
          const tag = yield* getAccuracyMetrics({ PredictorArn: arn }).pipe(
            Effect.map(() => "Found"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/forecast-probe") {
          const tag = yield* describeForecast({ ForecastArn: arn }).pipe(
            Effect.map(() => "Found"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/create-forecast-probe") {
          const tag = yield* createForecast({
            ForecastName: "alchemy_forecast_bindings_probe",
            PredictorArn: arn,
          }).pipe(
            Effect.map(() => "Created"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/stop-probe") {
          const tag = yield* stopResource({ ResourceArn: arn }).pipe(
            Effect.map(() => "Stopped"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/resume-probe") {
          const tag = yield* resumeResource({ ResourceArn: arn }).pipe(
            Effect.map(() => "Resumed"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/query-probe") {
          const tag = yield* queryForecast({
            ForecastArn: arn,
            Filters: { item_id: "alchemy_probe" },
          }).pipe(
            Effect.map(() => "Queried"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/whatif-query-probe") {
          const tag = yield* queryWhatIfForecast({
            WhatIfForecastArn: arn,
            Filters: { item_id: "alchemy_probe" },
          }).pipe(
            Effect.map(() => "Queried"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/export-create-probe") {
          const tag = yield* createForecastExportJob({
            ForecastExportJobName: "alchemy_forecast_export_probe",
            ForecastArn: arn,
            Destination: {
              S3Config: {
                Path: "s3://alchemy-nonexistent-probe-bucket/exports/",
                RoleArn: "arn:aws:iam::000000000000:role/alchemy_probe",
              },
            },
          }).pipe(
            Effect.map(() => "Created"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/export-probe") {
          const tag = yield* describeForecastExportJob({
            ForecastExportJobArn: arn,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "GET" &&
          pathname === "/whatif-analysis-create-probe"
        ) {
          const tag = yield* createWhatIfAnalysis({
            WhatIfAnalysisName: "alchemy_whatif_analysis_probe",
            ForecastArn: arn,
          }).pipe(
            Effect.map(() => "Created"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/whatif-analysis-probe") {
          const tag = yield* describeWhatIfAnalysis({
            WhatIfAnalysisArn: arn,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/whatif-create-probe") {
          const tag = yield* createWhatIfForecast({
            WhatIfForecastName: "alchemy_whatif_forecast_probe",
            WhatIfAnalysisArn: arn,
          }).pipe(
            Effect.map(() => "Created"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/whatif-forecast-probe") {
          const tag = yield* describeWhatIfForecast({
            WhatIfForecastArn: arn,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (
          request.method === "GET" &&
          pathname === "/whatif-export-create-probe"
        ) {
          const tag = yield* createWhatIfForecastExport({
            WhatIfForecastExportName: "alchemy_whatif_export_probe",
            WhatIfForecastArns: [arn],
            Destination: {
              S3Config: {
                Path: "s3://alchemy-nonexistent-probe-bucket/whatif/",
                RoleArn: "arn:aws:iam::000000000000:role/alchemy_probe",
              },
            },
          }).pipe(
            Effect.map(() => "Created"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/whatif-export-probe") {
          const tag = yield* describeWhatIfForecastExport({
            WhatIfForecastExportArn: arn,
          }).pipe(
            Effect.map(() => "Found"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        if (request.method === "GET" && pathname === "/delete-tree-probe") {
          const tag = yield* deleteResourceTree({ ResourceArn: arn }).pipe(
            Effect.map(() => "Deleted"),
            Effect.catch((e) => Effect.succeed(e._tag)),
          );
          return yield* HttpServerResponse.json({ tag });
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
        Forecast.CreateDatasetImportJobHttp,
        Forecast.DescribeDatasetImportJobHttp,
        Forecast.CreateAutoPredictorHttp,
        Forecast.DescribeAutoPredictorHttp,
        Forecast.GetAccuracyMetricsHttp,
        Forecast.CreateForecastHttp,
        Forecast.DescribeForecastHttp,
        Forecast.StopResourceHttp,
        Forecast.ResumeResourceHttp,
        Forecast.QueryForecastHttp,
        Forecast.QueryWhatIfForecastHttp,
        Forecast.CreateForecastExportJobHttp,
        Forecast.DescribeForecastExportJobHttp,
        Forecast.CreateWhatIfAnalysisHttp,
        Forecast.DescribeWhatIfAnalysisHttp,
        Forecast.CreateWhatIfForecastHttp,
        Forecast.DescribeWhatIfForecastHttp,
        Forecast.CreateWhatIfForecastExportHttp,
        Forecast.DescribeWhatIfForecastExportHttp,
        Forecast.DeleteResourceTreeHttp,
      ),
    ),
  ),
);
