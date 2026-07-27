import * as GeoPlaces from "@/AWS/GeoPlaces";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class GeoPlacesTestFunction extends Lambda.Function<Lambda.Function>()(
  "GeoPlacesTestFunction",
) {}

export default GeoPlacesTestFunction.make(
  {
    main,
    url: true,
    // geo-places calls fan out to upstream providers and can exceed Lambda's
    // 3s default.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const autocomplete = yield* GeoPlaces.Autocomplete();
    const geocode = yield* GeoPlaces.Geocode();
    const getPlace = yield* GeoPlaces.GetPlace();
    const reverseGeocode = yield* GeoPlaces.ReverseGeocode();
    const searchNearby = yield* GeoPlaces.SearchNearby();
    const searchText = yield* GeoPlaces.SearchText();
    const suggest = yield* GeoPlaces.Suggest();

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        // Cheap readiness route — no AWS call.
        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
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

        if (request.method === "GET" && pathname === "/get-place") {
          // GetPlace needs a PlaceId — resolve one via Geocode first.
          const geocoded = yield* geocode({
            QueryText: "Space Needle, Seattle, WA",
            MaxResults: 1,
          });
          const placeId = geocoded.ResultItems?.[0]?.PlaceId;
          if (placeId === undefined) {
            return yield* HttpServerResponse.json(
              { error: "geocode returned no PlaceId" },
              { status: 500 },
            );
          }
          const place = yield* getPlace({ PlaceId: placeId });
          return yield* HttpServerResponse.json({
            placeId: place.PlaceId,
            label: place.Address?.Label,
            pricingBucket: place.PricingBucket,
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

        if (request.method === "GET" && pathname === "/search-nearby") {
          const result = yield* searchNearby({
            // [longitude, latitude] — the Space Needle, Seattle.
            QueryPosition: [-122.3493, 47.6205],
            QueryRadius: 1000,
            MaxResults: 5,
          });
          const items = result.ResultItems ?? [];
          return yield* HttpServerResponse.json({
            count: items.length,
            firstTitle: items[0]?.Title,
            pricingBucket: result.PricingBucket,
          });
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

        if (request.method === "GET" && pathname === "/suggest") {
          const result = yield* suggest({
            QueryText: "coffee",
            // [longitude, latitude] — downtown Seattle.
            BiasPosition: [-122.3493, 47.6205],
            MaxResults: 5,
          });
          const items = result.ResultItems ?? [];
          return yield* HttpServerResponse.json({
            count: items.length,
            firstTitle: items[0]?.Title,
            firstType: items[0]?.SuggestResultItemType,
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
        GeoPlaces.AutocompleteHttp,
        GeoPlaces.GeocodeHttp,
        GeoPlaces.GetPlaceHttp,
        GeoPlaces.ReverseGeocodeHttp,
        GeoPlaces.SearchNearbyHttp,
        GeoPlaces.SearchTextHttp,
        GeoPlaces.SuggestHttp,
      ),
    ),
  ),
);
