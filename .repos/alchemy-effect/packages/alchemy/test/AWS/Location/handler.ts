import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as Location from "@/AWS/Location";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class LocationTestFunction extends Lambda.Function<Lambda.Function>()(
  "LocationTestFunction",
) {}

// Downtown Seattle — near the Space Needle. [longitude, latitude]
const SEATTLE: [number, number] = [-122.3493, 47.6205];
const PIKE_PLACE: [number, number] = [-122.3421, 47.6091];

// A syntactically valid but nonexistent job id — the /jobs/get-missing and
// /jobs/cancel-missing probe routes assert the typed ResourceNotFoundException.
const MISSING_JOB_ID = "00000000-0000-4000-8000-000000000000";

export default LocationTestFunction.make(
  {
    main,
    url: true,
    // Place-index and route-calculator calls fan out to upstream data
    // providers and can exceed Lambda's 3s default.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const tracker = yield* Location.Tracker("BindingsTracker", {});
    const collection = yield* Location.GeofenceCollection(
      "BindingsCollection",
      {},
    );
    // HERE (not Esri): SearchPlaceIndexForText only returns PlaceId — needed
    // by the /places/get-place route — for HERE and Grab data providers.
    const index = yield* Location.PlaceIndex("BindingsIndex", {
      dataSource: "Here",
    });
    const calculator = yield* Location.RouteCalculator("BindingsCalculator", {
      dataSource: "Esri",
    });
    const map = yield* Location.Map("BindingsMap", {
      configuration: { style: "VectorEsriNavigation" },
    });

    // A role for the StartJob binding — only used to exercise the binding's
    // deploy-time wiring (geo:StartJob + iam:PassRole grants); no job is ever
    // started, so the trust policy just needs a principal IAM accepts
    // ("location.amazonaws.com" is not a recognized service principal).
    const jobsRole = yield* IAM.Role("LocationJobsRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
    });

    // Event source: subscribe the host to Location geofence events. The
    // deploy proves the EventBridge rule + invoke permission wiring.
    yield* Location.consumeTrackerEvents(
      { kinds: ["geofence-event", "device-position-event"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `location event: ${event.detail.DeviceId} ${event.detail.EventType}`,
          ),
        ),
    );

    // Tracker data plane
    const updatePositions = yield* Location.BatchUpdateDevicePosition(tracker);
    const getPosition = yield* Location.GetDevicePosition(tracker);
    const getHistory = yield* Location.GetDevicePositionHistory(tracker);
    const listPositions = yield* Location.ListDevicePositions(tracker);
    const batchGetPositions = yield* Location.BatchGetDevicePosition(tracker);
    const verifyPosition = yield* Location.VerifyDevicePosition(tracker);
    const deleteHistory =
      yield* Location.BatchDeleteDevicePositionHistory(tracker);

    // Geofence data plane
    const putGeofence = yield* Location.PutGeofence(collection);
    const getGeofence = yield* Location.GetGeofence(collection);
    const listGeofences = yield* Location.ListGeofences(collection);
    const batchPutGeofence = yield* Location.BatchPutGeofence(collection);
    const batchDeleteGeofence = yield* Location.BatchDeleteGeofence(collection);
    const evaluateGeofences =
      yield* Location.BatchEvaluateGeofences(collection);
    const forecastEvents = yield* Location.ForecastGeofenceEvents(collection);

    // Places
    const searchText = yield* Location.SearchPlaceIndexForText(index);
    const searchPosition = yield* Location.SearchPlaceIndexForPosition(index);
    const suggest = yield* Location.SearchPlaceIndexForSuggestions(index);
    const getPlace = yield* Location.GetPlace(index);

    // Routes
    const calculateRoute = yield* Location.CalculateRoute(calculator);
    const calculateMatrix = yield* Location.CalculateRouteMatrix(calculator);

    // Map assets
    const getStyle = yield* Location.GetMapStyleDescriptor(map);
    const getGlyphs = yield* Location.GetMapGlyphs(map);
    const getSprites = yield* Location.GetMapSprites(map);
    const getTile = yield* Location.GetMapTile(map);

    // Batch metadata jobs
    const listJobs = yield* Location.ListJobs();
    const getJob = yield* Location.GetJob();
    const cancelJob = yield* Location.CancelJob();
    // Bound for its deploy-time wiring (geo:StartJob + iam:PassRole); starting
    // a real batch job needs S3 input/output data.
    yield* Location.StartJob(jobsRole);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        // Cheap readiness route — no AWS call.
        if (pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (pathname === "/tracker/update") {
          const result = yield* updatePositions({
            Updates: [
              {
                DeviceId: "device-1",
                Position: SEATTLE,
                SampleTime: new Date(),
              },
            ],
          });
          return yield* HttpServerResponse.json({
            errors: result.Errors.length,
          });
        }

        if (pathname === "/tracker/latest") {
          const latest = yield* getPosition({ DeviceId: "device-1" });
          return yield* HttpServerResponse.json({
            deviceId: latest.DeviceId,
            position: latest.Position,
          });
        }

        if (pathname === "/tracker/batch-get") {
          const result = yield* batchGetPositions({
            DeviceIds: ["device-1"],
          });
          return yield* HttpServerResponse.json({
            found: result.DevicePositions.length,
            errors: result.Errors.length,
          });
        }

        if (pathname === "/tracker/history") {
          const history = yield* getHistory({ DeviceId: "device-1" });
          return yield* HttpServerResponse.json({
            count: history.DevicePositions.length,
          });
        }

        if (pathname === "/tracker/list") {
          const page = yield* listPositions();
          return yield* HttpServerResponse.json({
            count: page.Entries.length,
            deviceIds: page.Entries.map((entry) => entry.DeviceId),
          });
        }

        if (pathname === "/tracker/verify") {
          const result = yield* verifyPosition({
            DeviceState: {
              DeviceId: "device-1",
              SampleTime: new Date(),
              Position: SEATTLE,
              WiFiAccessPoints: [{ MacAddress: "A0:EC:F9:1E:32:C1", Rss: -66 }],
            },
          }).pipe(
            Effect.map((verdict) => ({
              inferredState: verdict.InferredState !== undefined,
              deviceId: verdict.DeviceId,
            })),
            // Position verification needs real cell/Wi-Fi signal data; a
            // typed ValidationException still proves IAM + wiring.
            Effect.catchTag("ValidationException", (e) =>
              Effect.succeed({ validationError: e.message }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (pathname === "/tracker/delete-history") {
          const result = yield* deleteHistory({ DeviceIds: ["device-1"] });
          return yield* HttpServerResponse.json({
            errors: result.Errors.length,
          });
        }

        if (pathname === "/geofence/put") {
          const result = yield* putGeofence({
            GeofenceId: "fence-1",
            Geometry: { Circle: { Center: SEATTLE, Radius: 200 } },
          });
          return yield* HttpServerResponse.json({
            geofenceId: result.GeofenceId,
          });
        }

        if (pathname === "/geofence/get") {
          const fence = yield* getGeofence({ GeofenceId: "fence-1" });
          return yield* HttpServerResponse.json({
            geofenceId: fence.GeofenceId,
            status: fence.Status,
          });
        }

        if (pathname === "/geofence/list") {
          // Also serves as the test setup's IAM canary — always responds 200
          // and surfaces the typed failure tag so setup can wait for geo:*
          // authorization (or diagnose schema gaps) without blind 500s.
          const page = yield* Effect.result(listGeofences());
          return yield* HttpServerResponse.json(
            Result.isSuccess(page)
              ? { ok: true, count: (page.success.Entries ?? []).length }
              : {
                  ok: false,
                  tag: page.failure._tag,
                  message: String(page.failure),
                },
          );
        }

        if (pathname === "/geofence/batch-put") {
          const result = yield* batchPutGeofence({
            Entries: [
              {
                GeofenceId: "fence-2",
                Geometry: { Circle: { Center: PIKE_PLACE, Radius: 100 } },
              },
            ],
          });
          return yield* HttpServerResponse.json({
            successes: result.Successes.length,
            errors: result.Errors.length,
          });
        }

        if (pathname === "/geofence/evaluate") {
          const result = yield* Effect.result(
            evaluateGeofences({
              DevicePositionUpdates: [
                {
                  DeviceId: "device-1",
                  Position: SEATTLE,
                  SampleTime: new Date(),
                },
              ],
            }),
          );
          return yield* HttpServerResponse.json(
            Result.isSuccess(result)
              ? // Errors is omitted from the wire response when every update
                // evaluated cleanly (patched optional in distilled).
                { ok: true, errors: (result.success.Errors ?? []).length }
              : {
                  ok: false,
                  tag: result.failure._tag,
                  message: String(result.failure),
                },
          );
        }

        if (pathname === "/geofence/forecast") {
          const result = yield* forecastEvents({
            DeviceState: { Position: SEATTLE, Speed: 15 },
            TimeHorizonMinutes: 30,
          });
          return yield* HttpServerResponse.json({
            forecasted: result.ForecastedEvents.length,
            distanceUnit: result.DistanceUnit,
          });
        }

        if (pathname === "/geofence/batch-delete") {
          const result = yield* batchDeleteGeofence({
            GeofenceIds: ["fence-2"],
          });
          return yield* HttpServerResponse.json({
            errors: result.Errors.length,
          });
        }

        if (pathname === "/places/search-text") {
          const result = yield* searchText({
            Text: "Space Needle, Seattle, WA",
            BiasPosition: SEATTLE,
            MaxResults: 3,
          });
          return yield* HttpServerResponse.json({
            count: (result.Results ?? []).length,
            firstLabel: result.Results?.[0]?.Place?.Label,
          });
        }

        if (pathname === "/places/search-position") {
          const result = yield* searchPosition({
            Position: SEATTLE,
            MaxResults: 1,
          });
          return yield* HttpServerResponse.json({
            count: (result.Results ?? []).length,
            firstLabel: result.Results?.[0]?.Place?.Label,
          });
        }

        if (pathname === "/places/suggestions") {
          const result = yield* suggest({
            Text: "coffee",
            BiasPosition: SEATTLE,
            MaxResults: 5,
          });
          return yield* HttpServerResponse.json({
            count: (result.Results ?? []).length,
            firstText: result.Results?.[0]?.Text,
          });
        }

        if (pathname === "/places/get-place") {
          // GetPlace needs a PlaceId — resolve one via SearchText first.
          const searched = yield* searchText({
            Text: "Space Needle, Seattle, WA",
            BiasPosition: SEATTLE,
            MaxResults: 1,
          });
          const placeId = searched.Results?.[0]?.PlaceId;
          if (placeId === undefined) {
            return yield* HttpServerResponse.json({
              ok: false,
              tag: "NoPlaceId",
              message: "search returned no PlaceId",
            });
          }
          const place = yield* Effect.result(getPlace({ PlaceId: placeId }));
          return yield* HttpServerResponse.json(
            Result.isSuccess(place)
              ? {
                  ok: true,
                  label: place.success.Place?.Label,
                  point: place.success.Place?.Geometry?.Point,
                }
              : {
                  ok: false,
                  tag: place.failure._tag,
                  message: String(place.failure),
                },
          );
        }

        if (pathname === "/routes/calculate") {
          const route = yield* calculateRoute({
            DeparturePosition: SEATTLE,
            DestinationPosition: PIKE_PLACE,
          });
          return yield* HttpServerResponse.json({
            distance: route.Summary?.Distance,
            duration: route.Summary?.DurationSeconds,
          });
        }

        if (pathname === "/routes/matrix") {
          const matrix = yield* calculateMatrix({
            DeparturePositions: [SEATTLE],
            DestinationPositions: [PIKE_PLACE],
          });
          return yield* HttpServerResponse.json({
            rows: (matrix.RouteMatrix ?? []).length,
            distance: matrix.RouteMatrix?.[0]?.[0]?.Distance,
          });
        }

        if (pathname === "/map/style") {
          const style = yield* getStyle();
          return yield* HttpServerResponse.json({
            bytes: style.Blob?.length ?? 0,
            contentType: style.ContentType,
          });
        }

        if (pathname === "/map/glyphs") {
          const glyphs = yield* getGlyphs({
            FontStack: "Arial Regular",
            FontUnicodeRange: "0-255.pbf",
          });
          return yield* HttpServerResponse.json({
            bytes: glyphs.Blob?.length ?? 0,
          });
        }

        if (pathname === "/map/sprites") {
          const sprites = yield* getSprites({ FileName: "sprites.json" });
          return yield* HttpServerResponse.json({
            bytes: sprites.Blob?.length ?? 0,
          });
        }

        if (pathname === "/map/tile") {
          const tile = yield* getTile({ Z: "0", X: "0", Y: "0" });
          return yield* HttpServerResponse.json({
            bytes: tile.Blob?.length ?? 0,
            contentType: tile.ContentType,
          });
        }

        if (pathname === "/jobs/list") {
          const page = yield* listJobs();
          return yield* HttpServerResponse.json({
            count: page.Entries.length,
          });
        }

        if (pathname === "/jobs/get-missing") {
          const result = yield* Effect.result(
            getJob({ JobId: MISSING_JOB_ID }),
          );
          return yield* HttpServerResponse.json(
            Result.isSuccess(result)
              ? { tag: "found" }
              : {
                  tag: result.failure._tag,
                  message: String(result.failure),
                },
          );
        }

        if (pathname === "/jobs/cancel-missing") {
          const result = yield* Effect.result(
            cancelJob({ JobId: MISSING_JOB_ID }),
          );
          return yield* HttpServerResponse.json(
            Result.isSuccess(result)
              ? { tag: "cancelled" }
              : {
                  tag: result.failure._tag,
                  message: String(result.failure),
                },
          );
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
        Location.BatchUpdateDevicePositionHttp,
        Location.GetDevicePositionHttp,
        Location.GetDevicePositionHistoryHttp,
        Location.ListDevicePositionsHttp,
        Location.BatchGetDevicePositionHttp,
        Location.VerifyDevicePositionHttp,
        Location.BatchDeleteDevicePositionHistoryHttp,
        Location.PutGeofenceHttp,
        Location.GetGeofenceHttp,
        Location.ListGeofencesHttp,
        Location.BatchPutGeofenceHttp,
        Location.BatchDeleteGeofenceHttp,
        Location.BatchEvaluateGeofencesHttp,
        Location.ForecastGeofenceEventsHttp,
        Location.SearchPlaceIndexForTextHttp,
        Location.SearchPlaceIndexForPositionHttp,
        Location.SearchPlaceIndexForSuggestionsHttp,
        Location.GetPlaceHttp,
        Location.CalculateRouteHttp,
        Location.CalculateRouteMatrixHttp,
        Location.GetMapStyleDescriptorHttp,
        Location.GetMapGlyphsHttp,
        Location.GetMapSpritesHttp,
        Location.GetMapTileHttp,
        Location.ListJobsHttp,
        Location.GetJobHttp,
        Location.CancelJobHttp,
        Location.StartJobHttp,
      ),
    ),
  ),
);
