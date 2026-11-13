import { expect, it } from "@effect/vitest";
import { describe, vi } from "vite-plus/test";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerResponse } from "effect/http";
import { ASSET_ROUTE_PREFIX } from "./assets/AssetAccess.ts";
import { ATTACHMENT_UPLOAD_ROUTE_PREFIX } from "./assets/AttachmentUpload.ts";
import { openMediaFile } from "./assets/MediaFile.ts";

import {
  injectMcpAppCsp,
  injectMcpAppCookieBootstrap,
  injectMcpAppThemeBootstrap,
  MCP_APP_MAX_HTML_BYTES,
} from "@t3tools/shared/mcpApp";
import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";

import * as ServerConfig from "./config.ts";

import { assetResponseHeaders, assetFileResponse, downloadContentDisposition } from "./http.ts";
import * as ServerHttp from "./http.ts";
import { layerFileResponse } from "./http-part2.test.ts";

describe("MCP app asset responses", () => {
  it.effect(
    "transforms existing snapshots only with explicit render intent and fresh metadata",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-theme-" });
        const file = path.join(directory, "app.html");
        const html = injectMcpAppCsp(
          "<html><head><script>vendor()</script></head><body>☃</body></html>",
          undefined,
        );
        yield* fs.writeFileString(file, html);
        for (const method of ["GET", "HEAD"] as const) {
          const response = HttpServerResponse.toWeb(
            yield* assetFileResponse(
              { path: file, mimeType: "text/html", renderIntent: "mcp-app" },
              "bytes=0-1",
              undefined,
              method,
            ),
          );
          const expected = injectMcpAppCookieBootstrap(injectMcpAppThemeBootstrap(html));
          expect(response.status).toBe(200);
          expect(response.headers.get("content-length")).toBe(
            String(new TextEncoder().encode(expected).byteLength),
          );
          expect(response.headers.get("etag")).toBeNull();
          expect(response.headers.get("last-modified")).toBeNull();
          expect(response.headers.get("content-security-policy")).toBe(
            "sandbox allow-scripts allow-forms allow-popups allow-downloads",
          );
          expect(yield* Effect.promise(() => response.text())).toBe(
            method === "HEAD" ? "" : expected,
          );
        }
        for (const download of [false, true]) {
          const response = HttpServerResponse.toWeb(
            yield* assetFileResponse({
              path: file,
              mimeType: "text/html",
              download,
              ...(download ? { renderIntent: "mcp-app" as const } : {}),
            }),
          );
          expect(yield* Effect.promise(() => response.text())).toBe(html);
        }
      }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect("rejects oversized captures before transforming them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-theme-size-" });
      const file = path.join(directory, "app.html");
      yield* fs.writeFileString(file, "x".repeat(MCP_APP_MAX_HTML_BYTES + 128 * 1024 + 1));
      const response = yield* assetFileResponse({ path: file, renderIntent: "mcp-app" });
      expect(response.status).toBe(413);
    }).pipe(Effect.provide(layerFileResponse)),
  );
});

describe("browser API CORS", () => {
  it("accepts protocol negotiation with authenticated browser headers", async () => {
    const layerRoute = Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        yield* router.add("GET", "/api/environment", HttpServerResponse.empty());
      }),
    );
    const layerApp = Layer.merge(layerRoute, ServerHttp.layerBrowserApiCors).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "http-cors-test-" })),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(layerApp, { disableLogger: true });

    try {
      const response = await handler(
        new Request("https://backend.example/api/environment", {
          method: "OPTIONS",
          headers: {
            origin: "https://app.t3.codes",
            "access-control-request-method": "GET",
            "access-control-request-headers": [
              ORCHESTRATION_PROTOCOL_HEADER,
              "authorization",
              "dpop",
            ].join(", "),
          },
        }),
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      const allowedHeaders = new Set(
        (response.headers.get("access-control-allow-headers") ?? "")
          .split(",")
          .map((header) => header.trim().toLowerCase()),
      );
      expect(allowedHeaders.has(ORCHESTRATION_PROTOCOL_HEADER)).toBe(true);
      expect(allowedHeaders.has("authorization")).toBe(true);
      expect(allowedHeaders.has("dpop")).toBe(true);
    } finally {
      await dispose();
    }
  });
});

describe("untraced requests", () => {
  it.effect("keeps signed asset and upload URLs out of HTTP server spans", () =>
    Effect.gen(function* () {
      const serverSpans: Array<string> = [];
      const layerTracer = Layer.succeed(
        Tracer.Tracer,
        Tracer.make({
          span: (options) => {
            if (options.kind === "server") serverSpans.push(options.name);
            return new Tracer.NativeSpan(options);
          },
        }),
      );
      const layerRoutes = Layer.effectDiscard(
        Effect.gen(function* () {
          const router = yield* HttpRouter.HttpRouter;
          yield* router.add("GET", `${ASSET_ROUTE_PREFIX}/*`, HttpServerResponse.empty());
          yield* router.add(
            "POST",
            `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/*`,
            HttpServerResponse.empty(),
          );
          yield* router.add("GET", "/api/environment", HttpServerResponse.empty());
        }),
      );
      const services = yield* Layer.build(
        HttpRouter.serve(layerRoutes, { disableListenLog: true, disableLogger: true }).pipe(
          ServerHttp.withUntracedRequests,
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provide(layerTracer),
        ),
      );
      const client = Context.get(services, HttpClient.HttpClient);

      // Each URL is a bearer credential: url.full and url.path would carry it.
      for (const request of [
        HttpClientRequest.get(`${ASSET_ROUTE_PREFIX}/payload.signature/image.png`),
        HttpClientRequest.get(`${ASSET_ROUTE_PREFIX}/payload.signature/image.png?v=1`),
        HttpClientRequest.post(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/payload.signature`),
        HttpClientRequest.post(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/payload.signature?v=1`),
        HttpClientRequest.head(`${ASSET_ROUTE_PREFIX}/payload.signature/image.png`),
      ]) {
        expect((yield* client.execute(request)).status).toBe(204);
      }
      expect(serverSpans).toEqual([]);

      expect((yield* client.execute(HttpClientRequest.get("/api/environment"))).status).toBe(204);
      expect(serverSpans).toEqual(["GET"]);

      for (const path of [
        `${ASSET_ROUTE_PREFIX}-other/file`,
        `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}-other/token`,
      ]) {
        expect((yield* client.execute(HttpClientRequest.get(path))).status).toBe(404);
      }
      expect(serverSpans).toEqual(["GET", "GET", "GET"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
