import * as GeoMaps from "@/AWS/GeoMaps";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class GeoMapsTestFunction extends Lambda.Function<Lambda.Function>()(
  "GeoMapsTestFunction",
) {}

export default GeoMapsTestFunction.make(
  {
    main,
    url: true,
    // Map renders / tile fetches can take a few seconds; the AWS default
    // 3s Lambda timeout is too tight.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const getStaticMap = yield* GeoMaps.GetStaticMap();
    const getTile = yield* GeoMaps.GetTile();
    const getStyleDescriptor = yield* GeoMaps.GetStyleDescriptor();
    const getSprites = yield* GeoMaps.GetSprites();
    const getGlyphs = yield* GeoMaps.GetGlyphs();

    const bound = {
      getStaticMap,
      getTile,
      getStyleDescriptor,
      getSprites,
      getGlyphs,
    };

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

        if (request.method === "GET" && pathname === "/static-map") {
          const result = yield* getStaticMap({
            FileName: "map",
            Center: "-122.3493,47.6205",
            Zoom: 12,
            Width: 400,
            Height: 300,
          });
          return yield* HttpServerResponse.json({
            bytes: result.Blob?.length ?? 0,
            contentType: result.ContentType ?? null,
            pricingBucket: result.PricingBucket,
          });
        }

        if (request.method === "GET" && pathname === "/tile") {
          const result = yield* getTile({
            Tileset: "vector.basemap",
            Z: "0",
            X: "0",
            Y: "0",
          });
          return yield* HttpServerResponse.json({
            bytes: result.Blob?.length ?? 0,
            contentType: result.ContentType ?? null,
            pricingBucket: result.PricingBucket,
          });
        }

        if (request.method === "GET" && pathname === "/style-descriptor") {
          const result = yield* getStyleDescriptor({ Style: "Standard" });
          const text = result.Blob ? new TextDecoder().decode(result.Blob) : "";
          let version: number | null = null;
          try {
            version =
              (JSON.parse(text) as { version?: number }).version ?? null;
          } catch {
            version = null;
          }
          return yield* HttpServerResponse.json({
            bytes: result.Blob?.length ?? 0,
            contentType: result.ContentType ?? null,
            version,
          });
        }

        if (request.method === "GET" && pathname === "/sprites") {
          const result = yield* getSprites({
            FileName: "sprites.png",
            Style: "Standard",
            ColorScheme: "Light",
            Variant: "Default",
          });
          return yield* HttpServerResponse.json({
            bytes: result.Blob?.length ?? 0,
            contentType: result.ContentType ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/glyphs") {
          const result = yield* getGlyphs({
            FontStack: "Amazon Ember Regular",
            FontUnicodeRange: "0-255.pbf",
          });
          return yield* HttpServerResponse.json({
            bytes: result.Blob?.length ?? 0,
            contentType: result.ContentType ?? null,
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
        GeoMaps.GetStaticMapHttp,
        GeoMaps.GetTileHttp,
        GeoMaps.GetStyleDescriptorHttp,
        GeoMaps.GetSpritesHttp,
        GeoMaps.GetGlyphsHttp,
      ),
    ),
  ),
);
