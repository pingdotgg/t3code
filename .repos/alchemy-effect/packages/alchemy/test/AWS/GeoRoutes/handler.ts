import * as GeoRoutes from "@/AWS/GeoRoutes";
import * as Lambda from "@/AWS/Lambda";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class GeoRoutesTestFunction extends Lambda.Function<Lambda.Function>()(
  "GeoRoutesTestFunction",
) {}

export default GeoRoutesTestFunction.make(
  {
    main,
    url: true,
    // Geo calls fan out to upstream providers and can exceed Lambda's 3s default.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const calculateRoutes = yield* GeoRoutes.CalculateRoutes();
    const calculateIsolines = yield* GeoRoutes.CalculateIsolines();
    const calculateRouteMatrix = yield* GeoRoutes.CalculateRouteMatrix();
    const optimizeWaypoints = yield* GeoRoutes.OptimizeWaypoints();
    const snapToRoads = yield* GeoRoutes.SnapToRoads();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        // Cheap readiness route — no AWS call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/calculate-routes") {
          const result = yield* calculateRoutes({
            // [longitude, latitude] — two points in Seattle.
            Origin: [-122.339, 47.61],
            Destination: [-122.201, 47.61],
            TravelMode: "Car",
          });
          const routes = result.Routes ?? [];
          return yield* HttpServerResponse.json({
            count: routes.length,
            distance: routes[0]?.Summary?.Distance,
            duration: routes[0]?.Summary?.Duration,
          });
        }

        if (request.method === "GET" && pathname === "/calculate-isolines") {
          const result = yield* calculateIsolines({
            // [longitude, latitude] — downtown Seattle.
            Origin: [-122.339, 47.61],
            // 10-minute drive-time isochrone.
            Thresholds: { Time: [600] },
            TravelMode: "Car",
          });
          const isolines = result.Isolines ?? [];
          return yield* HttpServerResponse.json({
            count: isolines.length,
            geometryCount: isolines[0]?.Geometries?.length ?? 0,
            pricingBucket: result.PricingBucket,
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/calculate-route-matrix"
        ) {
          const result = yield* calculateRouteMatrix({
            // [longitude, latitude] — 2x2 matrix within the Seattle area.
            Origins: [
              { Position: [-122.339, 47.61] },
              { Position: [-122.335, 47.608] },
            ],
            Destinations: [
              { Position: [-122.201, 47.61] },
              { Position: [-122.313, 47.62] },
            ],
            RoutingBoundary: {
              Geometry: {
                // Radius in meters — covers all origins and destinations.
                Circle: { Center: [-122.3, 47.61], Radius: 30_000 },
              },
            },
          });
          const matrix = result.RouteMatrix ?? [];
          return yield* HttpServerResponse.json({
            rows: matrix.length,
            columns: matrix[0]?.length ?? 0,
            firstDuration: matrix[0]?.[0]?.Duration,
            errorCount: result.ErrorCount,
            pricingBucket: result.PricingBucket,
          });
        }

        if (request.method === "GET" && pathname === "/optimize-waypoints") {
          const result = yield* optimizeWaypoints({
            // [longitude, latitude] — Seattle loop with two stops.
            Origin: [-122.339, 47.61],
            Destination: [-122.201, 47.61],
            Waypoints: [
              { Id: "stop-1", Position: [-122.335, 47.608] },
              { Id: "stop-2", Position: [-122.313, 47.62] },
            ],
          });
          return yield* HttpServerResponse.json({
            optimizedCount: result.OptimizedWaypoints?.length ?? 0,
            order: (result.OptimizedWaypoints ?? []).map((w) => w.Id),
            distance: result.Distance,
            duration: result.Duration,
            pricingBucket: result.PricingBucket,
          });
        }

        if (request.method === "GET" && pathname === "/snap-to-roads") {
          const result = yield* snapToRoads({
            // [longitude, latitude] — a short GPS trace along a Seattle street.
            TracePoints: [
              { Position: [-122.339, 47.61] },
              { Position: [-122.337, 47.609] },
              { Position: [-122.335, 47.608] },
            ],
            TravelMode: "Car",
          });
          return yield* HttpServerResponse.json({
            snappedCount: result.SnappedTracePoints?.length ?? 0,
            firstConfidence: result.SnappedTracePoints?.[0]?.Confidence,
            pricingBucket: result.PricingBucket,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(
        // Surface the typed error (tag + message) instead of an opaque 500 so
        // test failures show the real cause in the response body.
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
        GeoRoutes.CalculateRoutesHttp,
        GeoRoutes.CalculateIsolinesHttp,
        GeoRoutes.CalculateRouteMatrixHttp,
        GeoRoutes.OptimizeWaypointsHttp,
        GeoRoutes.SnapToRoadsHttp,
      ),
    ),
  ),
);
