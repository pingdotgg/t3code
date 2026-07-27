import * as GeoMaps from "@/AWS/GeoMaps";
import * as GeoPlaces from "@/AWS/GeoPlaces";
import * as GeoRoutes from "@/AWS/GeoRoutes";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class GeoTestFunction extends Lambda.Function<Lambda.Function>()(
  "GeoTestFunction",
) {}

export default GeoTestFunction.make(
  {
    main,
    url: true,
    // Geo calls fan out to upstream providers and can exceed Lambda's 3s default.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const searchText = yield* GeoPlaces.SearchText();
    const geocode = yield* GeoPlaces.Geocode();
    const reverseGeocode = yield* GeoPlaces.ReverseGeocode();
    const autocomplete = yield* GeoPlaces.Autocomplete();
    const calculateRoutes = yield* GeoRoutes.CalculateRoutes();
    const calculateIsolines = yield* GeoRoutes.CalculateIsolines();
    const getTile = yield* GeoMaps.GetTile();
    const getStaticMap = yield* GeoMaps.GetStaticMap();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        // Cheap readiness route — no AWS call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "GET" && pathname === "/search-text") {
          const result = yield* searchText({
            QueryText: "Space Needle, Seattle, WA",
            MaxResults: 5,
            // SearchText requires exactly one of BiasPosition,
            // Filter.BoundingBox, or Filter.Circle. [longitude, latitude]
            BiasPosition: [-122.3493, 47.6205],
          });
          const items = result.ResultItems ?? [];
          return yield* HttpServerResponse.json({
            count: items.length,
            firstPosition: items[0]?.Position,
          });
        }

        if (request.method === "GET" && pathname === "/geocode") {
          const result = yield* geocode({
            QueryText: "1600 Pennsylvania Ave NW, Washington, DC",
            MaxResults: 1,
          });
          const items = result.ResultItems ?? [];
          return yield* HttpServerResponse.json({
            count: items.length,
            position: items[0]?.Position,
          });
        }

        if (request.method === "GET" && pathname === "/reverse-geocode") {
          const result = yield* reverseGeocode({
            // [longitude, latitude] — near the Space Needle, Seattle.
            QueryPosition: [-122.3493, 47.6205],
            MaxResults: 1,
          });
          const items = result.ResultItems ?? [];
          return yield* HttpServerResponse.json({
            count: items.length,
            label: items[0]?.Address?.Label,
          });
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

        if (request.method === "GET" && pathname === "/autocomplete") {
          const result = yield* autocomplete({
            QueryText: "1600 Pennsylvania",
            MaxResults: 5,
          });
          const items = result.ResultItems ?? [];
          return yield* HttpServerResponse.json({
            count: items.length,
            firstTitle: items[0]?.Title,
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

        if (request.method === "GET" && pathname === "/get-tile") {
          const result = yield* getTile({
            Tileset: "vector.basemap",
            Z: "0",
            X: "0",
            Y: "0",
          });
          return yield* HttpServerResponse.json({
            byteLength: result.Blob?.byteLength ?? 0,
            contentType: result.ContentType,
            pricingBucket: result.PricingBucket,
          });
        }

        if (request.method === "GET" && pathname === "/get-static-map") {
          const result = yield* getStaticMap({
            // FileName must match ^map(@2x)?$ (it is the {FileName} path label).
            FileName: "map",
            // "longitude,latitude" — the Space Needle, Seattle.
            Center: "-122.3493,47.6205",
            Zoom: 12,
            Width: 400,
            Height: 300,
          });
          return yield* HttpServerResponse.json({
            byteLength: result.Blob?.byteLength ?? 0,
            contentType: result.ContentType,
            pricingBucket: result.PricingBucket,
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
        GeoPlaces.SearchTextHttp,
        GeoPlaces.GeocodeHttp,
        GeoPlaces.ReverseGeocodeHttp,
        GeoPlaces.AutocompleteHttp,
        GeoRoutes.CalculateRoutesHttp,
        GeoRoutes.CalculateIsolinesHttp,
        GeoMaps.GetTileHttp,
        GeoMaps.GetStaticMapHttp,
      ),
    ),
  ),
);
