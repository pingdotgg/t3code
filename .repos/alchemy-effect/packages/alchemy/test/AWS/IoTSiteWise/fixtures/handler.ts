import * as IoTSiteWise from "@/AWS/IoTSiteWise";
import * as Lambda from "@/AWS/Lambda";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class IoTSiteWiseTestFunction extends Lambda.Function<Lambda.Function>()(
  "IoTSiteWiseTestFunction",
) {}

export default IoTSiteWiseTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const model = yield* IoTSiteWise.AssetModel("BindingsPumpModel", {
      assetModelDescription: "alchemy iotsitewise bindings fixture",
      assetModelProperties: [
        {
          name: "Temperature",
          dataType: "DOUBLE",
          unit: "Celsius",
          type: { measurement: {} },
        },
      ],
      tags: { fixture: "iotsitewise-bindings" },
    });
    const asset = yield* IoTSiteWise.Asset("BindingsPump", {
      assetModelId: model.assetModelId,
      assetDescription: "alchemy iotsitewise bindings fixture asset",
      tags: { fixture: "iotsitewise-bindings" },
    });

    const describeAsset = yield* IoTSiteWise.DescribeAsset(asset);
    const listProperties = yield* IoTSiteWise.ListAssetProperties(asset);
    const putValues = yield* IoTSiteWise.BatchPutAssetPropertyValue(asset);
    const getValue = yield* IoTSiteWise.GetAssetPropertyValue(asset);
    const getHistory = yield* IoTSiteWise.GetAssetPropertyValueHistory(asset);
    const getAggregates = yield* IoTSiteWise.GetAssetPropertyAggregates(asset);
    const getInterpolated =
      yield* IoTSiteWise.GetInterpolatedAssetPropertyValues(asset);
    const executeQuery = yield* IoTSiteWise.ExecuteQuery();

    // Resolve the service-assigned id of the Temperature property by name —
    // exercises the DescribeAsset binding on every data-plane route.
    const temperaturePropertyId = Effect.gen(function* () {
      const described = yield* describeAsset();
      const property = described.assetProperties.find(
        (p) => p.name === "Temperature",
      );
      if (!property) {
        return yield* Effect.fail(
          new Error("Temperature property not found on the bound asset"),
        );
      }
      return property.id;
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        // Cheap readiness route — no AWS call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/describe") {
          const described = yield* describeAsset();
          return yield* HttpServerResponse.json({
            assetId: described.assetId,
            assetName: described.assetName,
            propertyNames: described.assetProperties.map((p) => p.name),
          });
        }

        if (request.method === "POST" && pathname === "/properties") {
          const listed = yield* listProperties({ filter: "ALL" });
          return yield* HttpServerResponse.json({
            count: listed.assetPropertySummaries.length,
          });
        }

        if (request.method === "POST" && pathname === "/put") {
          const propertyId = yield* temperaturePropertyId;
          // Fresh timestamp per call so retried requests never collide with
          // an already-ingested TQV.
          const now = yield* Effect.sync(() => Math.floor(Date.now() / 1000));
          const result = yield* putValues({
            entries: [
              {
                entryId: `temp-${now}`,
                propertyId,
                propertyValues: [
                  {
                    value: { doubleValue: 23.5 },
                    timestamp: { timeInSeconds: now },
                    quality: "GOOD",
                  },
                ],
              },
            ],
          });
          return yield* HttpServerResponse.json({
            errorCount: result.errorEntries.length,
            errorCodes: result.errorEntries.flatMap((entry) =>
              entry.errors.map((error) => error.errorCode),
            ),
          });
        }

        if (request.method === "POST" && pathname === "/value") {
          const propertyId = yield* temperaturePropertyId;
          const result = yield* getValue({ propertyId });
          return yield* HttpServerResponse.json({
            doubleValue: result.propertyValue?.value.doubleValue ?? null,
            timeInSeconds:
              result.propertyValue?.timestamp.timeInSeconds ?? null,
          });
        }

        if (request.method === "POST" && pathname === "/history") {
          const propertyId = yield* temperaturePropertyId;
          const now = yield* Effect.sync(() => Date.now());
          const result = yield* getHistory({
            propertyId,
            startDate: new Date(now - 600_000),
            endDate: new Date(now),
            timeOrdering: "DESCENDING",
          });
          return yield* HttpServerResponse.json({
            count: result.assetPropertyValueHistory.length,
          });
        }

        if (request.method === "POST" && pathname === "/aggregates") {
          const propertyId = yield* temperaturePropertyId;
          const now = yield* Effect.sync(() => Date.now());
          const result = yield* getAggregates({
            propertyId,
            aggregateTypes: ["AVERAGE"],
            resolution: "1m",
            startDate: new Date(now - 3_600_000),
            endDate: new Date(now),
          });
          return yield* HttpServerResponse.json({
            ok: true,
            count: result.aggregatedValues.length,
          });
        }

        if (request.method === "POST" && pathname === "/interpolated") {
          const propertyId = yield* temperaturePropertyId;
          const now = yield* Effect.sync(() => Math.floor(Date.now() / 1000));
          const result = yield* getInterpolated({
            propertyId,
            startTimeInSeconds: now - 3600,
            endTimeInSeconds: now,
            intervalInSeconds: 60,
            quality: "GOOD",
            type: "LINEAR_INTERPOLATION",
          });
          return yield* HttpServerResponse.json({
            ok: true,
            count: result.interpolatedAssetPropertyValues.length,
          });
        }

        if (request.method === "POST" && pathname === "/query") {
          const described = yield* describeAsset();
          const result = yield* executeQuery({
            queryStatement: `SELECT asset_id, asset_name FROM asset WHERE asset_id = '${described.assetId}'`,
          });
          return yield* HttpServerResponse.json({
            ok: true,
            rowCount: result.rows?.length ?? 0,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(
        // Surface the failure cause in the 500 body so the test's retry
        // error carries the real diagnostic instead of an opaque
        // "Internal Server Error".
        Effect.catchCause((cause) =>
          HttpServerResponse.json(
            { error: Cause.pretty(cause) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        IoTSiteWise.DescribeAssetHttp,
        IoTSiteWise.ListAssetPropertiesHttp,
        IoTSiteWise.BatchPutAssetPropertyValueHttp,
        IoTSiteWise.GetAssetPropertyValueHttp,
        IoTSiteWise.GetAssetPropertyValueHistoryHttp,
        IoTSiteWise.GetAssetPropertyAggregatesHttp,
        IoTSiteWise.GetInterpolatedAssetPropertyValuesHttp,
        IoTSiteWise.ExecuteQueryHttp,
      ),
    ),
  ),
);
