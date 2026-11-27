import { expect, it } from "@effect/vitest";
import { describe, vi } from "vite-plus/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
import { openMediaFile } from "./assets/MediaFile.ts";

import {
  injectMcpAppCsp,
  injectMcpAppCookieBootstrap,
  injectMcpAppDocumentBootstrap,
  injectMcpAppThemeBootstrap,
  MCP_APP_MAX_HTML_BYTES,
} from "@t3tools/shared/mcpApp";
import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import {
  DESKTOP_READINESS_PROOF_PATH,
  isValidDesktopReadinessProof,
} from "@t3tools/shared/desktopReadinessProof";
import { FILE_PREVIEW_SCROLL_SCRIPT } from "@t3tools/shared/htmlRender";

import * as ServerConfig from "./config.ts";

import { assetResponseHeaders, assetFileResponse, downloadContentDisposition } from "./http.ts";
import * as ServerHttp from "./http.ts";

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
          const expected = injectMcpAppDocumentBootstrap(
            injectMcpAppCookieBootstrap(injectMcpAppThemeBootstrap(html)),
          );
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

describe("workspace page preview responses", () => {
  it.effect("append the scroll script only to inline HTML previews", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-file-preview-" });
      const page = path.join(directory, "report.html");
      const style = path.join(directory, "report.css");
      const html = "<!doctype html><html><body>☃</body></html>";
      yield* fs.writeFileString(page, html);
      yield* fs.writeFileString(style, "body{}");
      const read = (asset: Parameters<typeof assetFileResponse>[0]) =>
        assetFileResponse(asset).pipe(
          Effect.flatMap((response) =>
            Effect.promise(() => HttpServerResponse.toWeb(response).text()),
          ),
        );
      const response = HttpServerResponse.toWeb(
        yield* assetFileResponse({ path: page, renderIntent: "file-preview" }, "bytes=0-1"),
      );
      const expected = html + FILE_PREVIEW_SCROLL_SCRIPT;
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(
        String(new TextEncoder().encode(expected).byteLength),
      );
      expect(yield* Effect.promise(() => response.text())).toBe(expected);
      expect(yield* read({ path: page, renderIntent: "file-preview", download: true })).toBe(html);
      expect(yield* read({ path: page })).toBe(html);
      expect(yield* read({ path: style, renderIntent: "file-preview" })).toBe("body{}");
    }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect("make the browser revalidate the page and the files it loads on refresh", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-file-preview-" });
      const page = path.join(directory, "report.html");
      const style = path.join(directory, "report.css");
      yield* fs.writeFileString(page, "<!doctype html><html><body>☃</body></html>");
      yield* fs.writeFileString(style, "body{}");
      for (const file of [page, style]) {
        const response = HttpServerResponse.toWeb(
          yield* assetFileResponse({ path: file, renderIntent: "file-preview" }),
        );
        // A fresh max-age lets a plain reload reuse the old CSS/JS after the file changes on disk.
        expect(response.headers.get("cache-control"), file).toMatch(/no-cache|no-store/);
      }
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

  it("allows originless desktop requests in dev mode while still rejecting disallowed browser origins", async () => {
    const layerRoute = Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        yield* router.add(
          "GET",
          "/api/environment",
          HttpServerResponse.empty({ headers: { vary: "Accept-Encoding" } }),
        );
      }),
    );
    const layerDevConfig = Layer.effect(
      ServerConfig.ServerConfig,
      Effect.map(ServerConfig.ServerConfig, (config) => ({
        ...config,
        devUrl: new URL("http://127.0.0.1:5733"),
      })),
    ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "http-dev-cors-test-" })));
    const layerApp = Layer.merge(layerRoute, ServerHttp.layerBrowserApiCors).pipe(
      Layer.provide(layerDevConfig),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(layerApp, { disableLogger: true });

    try {
      const originless = await handler(
        new Request("https://dev.example/api/environment", { method: "GET" }),
      );
      expect(originless.headers.get("access-control-allow-origin")).toBe("*");
      expect(originless.headers.get("access-control-allow-credentials")).toBeNull();
      expect(originless.headers.get("vary")).toBe("Accept-Encoding, Origin");

      const originlessPreflight = await handler(
        new Request("https://dev.example/api/environment", { method: "OPTIONS" }),
      );
      expect(originlessPreflight.status).toBe(204);
      expect(originlessPreflight.headers.get("access-control-allow-origin")).toBe("*");
      expect(originlessPreflight.headers.get("vary")).toBe("Origin");

      const allowed = await handler(
        new Request("https://dev.example/api/environment", {
          method: "GET",
          headers: { origin: "http://127.0.0.1:5733" },
        }),
      );
      expect(allowed.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5733");
      expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");

      const disallowed = await handler(
        new Request("https://dev.example/api/environment", {
          method: "GET",
          headers: { origin: "https://evil.example" },
        }),
      );
      expect(disallowed.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await dispose();
    }
  });
});

describe("desktop readiness proof", () => {
  // Request handlers read these from the app's own context.
  const serveRoute = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          ServerHttp.layerDesktopReadinessProofRoute.pipe(
            Layer.provideMerge(
              Layer.effect(
                ServerConfig.ServerConfig,
                Effect.map(ServerConfig.ServerConfig, (config) => ({ ...config, ...overrides })),
              ).pipe(
                Layer.provide(
                  ServerConfig.layerTest(process.cwd(), { prefix: "http-readiness-test-" }),
                ),
              ),
            ),
            Layer.provideMerge(NodeCrypto.layerMac),
            Layer.provide(NodeServices.layer),
          ),
          { disableLogger: true },
        ),
      ),
      ({ dispose }) => Effect.promise(() => dispose()),
    ).pipe(
      Effect.map(
        ({ handler }) =>
          (query: string) =>
            Effect.promise(() =>
              handler(
                new Request(`http://172.20.84.98:3773${DESKTOP_READINESS_PROOF_PATH}${query}`),
              ),
            ),
      ),
    );

  it.effect("answers a challenge with a proof bound to the launch's readiness secret", () =>
    Effect.gen(function* () {
      const get = yield* serveRoute({ desktopReadinessSecret: "launch-secret" });

      const response = yield* get("?challenge=abc123");
      const proof = yield* Effect.promise(() => response.text());

      expect(response.status).toBe(200);
      expect(yield* isValidDesktopReadinessProof("launch-secret", "abc123", proof)).toBe(true);
      expect(yield* isValidDesktopReadinessProof("launch-secret", "other", proof)).toBe(false);
      expect(yield* isValidDesktopReadinessProof("another-launch", "abc123", proof)).toBe(false);
      expect(proof).not.toContain("launch-secret");

      expect((yield* get("")).status).toBe(404);
      expect((yield* get(`?challenge=${"a".repeat(129)}`)).status).toBe(404);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layerMac)),
  );

  it.effect("does not answer on a server launched without a readiness secret", () =>
    Effect.gen(function* () {
      const get = yield* serveRoute({});

      expect((yield* get("?challenge=abc123")).status).toBe(404);
    }).pipe(Effect.scoped),
  );
});

describe("untraced requests", () => {
  it.effect("starts a separate trace for each request, not the server's lifetime trace", () =>
    Effect.gen(function* () {
      const requestSpans: Array<Tracer.NativeSpan> = [];
      const layerTracer = Layer.succeed(
        Tracer.Tracer,
        Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            if (options.kind === "server") requestSpans.push(span);
            return span;
          },
        }),
      );
      const layerRoutes = Layer.effectDiscard(
        Effect.gen(function* () {
          const router = yield* HttpRouter.HttpRouter;
          yield* router.add("GET", "/api/environment", HttpServerResponse.empty());
        }),
      );
      const services = yield* Layer.build(
        HttpRouter.serve(layerRoutes, { disableListenLog: true, disableLogger: true }).pipe(
          ServerHttp.withRootRequestSpans,
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      ).pipe(Effect.withSpan("server.lifetime"), Effect.provide(layerTracer));
      // Without a traceparent header, the server alone decides each request's parent.
      const client = Context.get(services, HttpClient.HttpClient);

      for (let i = 0; i < 2; i++) {
        yield* client
          .execute(HttpClientRequest.get("/api/environment"))
          .pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
      }
      expect(requestSpans.map((span) => span.parent._tag)).toEqual(["None", "None"]);
      expect(new Set(requestSpans.map((span) => span.traceId)).size).toBe(2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const layerFileResponse = Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer);

const makeStaticRequest = Effect.fn("HttpTest.makeStaticRequest")(function* (staticDir: string) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const layerApp = Layer.merge(
    ServerHttp.layerStaticAndDevRoute,
    ServerHttp.layerHttpCompression,
  ).pipe(Layer.provideMerge(NodeHttpPlatform.layer));
  // HttpRouter.serve prefers outer services; inject the test FileSystem between it and NodeHttpServer.layerTest.
  const services = yield* Layer.build(
    HttpRouter.serve(layerApp, { disableListenLog: true }).pipe(
      Layer.provideMerge(ServerConfig.layer({ ...config, staticDir })),
      Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, fileSystem)),
      Layer.provideMerge(NodeHttpServer.layerTest),
    ),
  );
  const client = Context.get(services, HttpClient.HttpClient);
  return (resource: string, options?: HttpClientRequest.Options) =>
    client.execute(HttpClientRequest.make(options?.method ?? "GET")(resource, options));
});

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-static-http-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("static HTTP responses", (it) => {
  it.effect("revalidates non-HTML files and returns changed contents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-static-cache-" });
      const assetPath = path.join(staticDir, "app.js");
      yield* fs.writeFileString(assetPath, 'export const build = "first";');
      const request = yield* makeStaticRequest(staticDir);

      const initial = yield* request("/app.js");
      expect(initial.status).toBe(200);
      expect(yield* initial.text).toContain("first");
      const etag = initial.headers["etag"]!;
      const lastModified = initial.headers["last-modified"]!;
      expect(etag).toBeTruthy();
      expect(lastModified).toBeTruthy();
      for (const headers of [
        { "if-none-match": etag },
        { "if-none-match": etag.replace(/^W\//, "") },
        { "if-none-match": `"other", ${etag}` },
        { "if-none-match": "*" },
        { "if-modified-since": lastModified },
      ]) {
        const response = yield* request("/app.js", { headers });
        expect(response.status).toBe(304);
        expect(response.headers["etag"]).toBe(etag);
        expect(response.headers["cache-control"]).toBe("no-cache");
        expect(yield* response.text).toBe("");
      }
      const mismatched = yield* request("/app.js", {
        headers: { "if-none-match": '"another-build"', "if-modified-since": lastModified },
      });
      expect(mismatched.status).toBe(200);
      expect(yield* mismatched.text).toContain("first");

      yield* fs.writeFileString(assetPath, 'export const build = "the next build";');
      const changed = yield* request("/app.js", { headers: { "if-none-match": etag } });
      expect(changed.status).toBe(200);
      expect(changed.headers["etag"]).not.toBe(etag);
      expect(yield* changed.text).toContain("next build");
    }),
  );

  it.effect("serves static files without handles and skips fallback reads for HEAD and 304", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-static-no-open-" });
      const filePath = path.join(staticDir, "app.txt");
      const body = "packaged asset";
      yield* fs.writeFileString(filePath, body);
      let reads = 0;
      // Electron asar files can be statted and read even when opening a handle fails.
      const fileSystem = FileSystem.FileSystem.of({
        ...fs,
        open: (candidate, options) =>
          candidate === filePath
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "open",
                  pathOrDescriptor: candidate,
                }),
              )
            : fs.open(candidate, options),
        readFile: (candidate) =>
          Effect.gen(function* () {
            if (candidate === filePath) reads += 1;
            return yield* fs.readFile(candidate);
          }),
      });
      const request = yield* makeStaticRequest(staticDir).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );

      const get = yield* request("/app.txt");
      expect(get.status).toBe(200);
      expect(yield* get.text).toBe(body);
      expect(reads).toBeGreaterThan(0);
      const readsAfterGet = reads;
      const head = yield* request("/app.txt", { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(yield* head.text).toBe("");
      expect(reads).toBe(readsAfterGet);
      const unchanged = yield* request("/app.txt", {
        headers: { "if-none-match": get.headers["etag"]! },
      });
      expect(unchanged.status).toBe(304);
      expect(yield* unchanged.text).toBe("");
      expect(reads).toBe(readsAfterGet);
    }),
  );

  it.effect("serves replacement bytes with matching static fallback length and validators", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-static-replaced-" });
      const filePath = path.join(staticDir, "app.txt");
      const before = DateTime.toDateUtc(DateTime.makeUnsafe("1985-10-26T08:15:00.000Z"));
      const after = DateTime.toDateUtc(DateTime.makeUnsafe("2015-10-21T16:29:00.000Z"));
      const replacement = "the replacement asset";
      const replacementPath = path.join(staticDir, "replacement.txt");
      yield* fs.writeFileString(filePath, "old");
      yield* fs.utimes(filePath, before, before);
      yield* fs.writeFileString(replacementPath, replacement);
      yield* fs.utimes(replacementPath, after, after);
      let replaceOnOpen = false;
      const fileSystem = FileSystem.FileSystem.of({
        ...fs,
        open: (candidate, options) =>
          Effect.gen(function* () {
            if (candidate !== filePath) return yield* fs.open(candidate, options);
            if (replaceOnOpen) {
              yield* fs.rename(replacementPath, filePath);
              replaceOnOpen = false;
            }
            return yield* PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "open",
              pathOrDescriptor: candidate,
            });
          }),
      });
      const request = yield* makeStaticRequest(staticDir).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );
      const initial = yield* request("/app.txt", { headers: { "accept-encoding": "identity" } });
      expect(yield* initial.text).toBe("old");

      replaceOnOpen = true;
      const response = yield* request("/app.txt", { headers: { "accept-encoding": "identity" } });
      expect(response.status).toBe(200);
      expect(response.headers).toMatchObject({
        "content-length": String(Buffer.byteLength(replacement)),
        "last-modified": after.toUTCString(),
      });
      expect(response.headers["etag"]).not.toBe(initial.headers["etag"]);
      expect(yield* response.text).toBe(replacement);
    }),
  );

  it.effect("serves changed HTML when deployments preserve its size and timestamp", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-static-html-" });
      const indexPath = path.join(staticDir, "index.html");
      const modifiedAt = DateTime.toDateUtc(DateTime.makeUnsafe("1985-10-26T08:15:00.000Z"));
      yield* fs.writeFileString(indexPath, "<html>old build</html>");
      yield* fs.utimes(indexPath, modifiedAt, modifiedAt);
      const request = yield* makeStaticRequest(staticDir);
      const initial = yield* request("/");
      expect(yield* initial.text).toBe("<html>old build</html>");
      const previousEtag = initial.headers["etag"] ?? '"previous-html"';
      const nextHtml = "<html>new build</html>";
      yield* fs.writeFileString(indexPath, nextHtml);
      yield* fs.utimes(indexPath, modifiedAt, modifiedAt);

      for (const [resource, headers] of [
        ["/", { "if-none-match": previousEtag }],
        ["/threads/example", { "if-modified-since": modifiedAt.toUTCString() }],
        ["/", { "if-none-match": "*" }],
      ] as const) {
        const response = yield* request(resource, { headers });
        expect(response.status).toBe(200);
        expect(yield* response.text).toBe(nextHtml);
        expect(response.headers["cache-control"]).toBe("no-cache");
        expect(response.headers["content-security-policy"]).toBe("frame-ancestors 'none'");
        expect(response.headers["x-frame-options"]).toBe("DENY");
        expect(response.headers["etag"]).toBeUndefined();
        expect(response.headers["last-modified"]).toBeUndefined();
      }
      const head = yield* request("/", {
        method: "HEAD",
        headers: { "if-none-match": previousEtag, "accept-encoding": "identity" },
      });
      expect(head.status).toBe(200);
      expect(head.headers["content-length"]).toBe(String(Buffer.byteLength(nextHtml)));
      expect(yield* head.text).toBe("");
    }),
  );

  it.effect("closes static descriptors after GET, HEAD, 304, and request cancellation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-static-close-" });
      const filePath = path.join(staticDir, "app.txt");
      const body = "file content\n".repeat(1024);
      yield* fs.writeFileString(filePath, body);
      const closed = yield* Queue.unbounded<FileSystem.File>();
      const blocked = yield* Deferred.make<void>();
      const active = new Set<FileSystem.File>();
      let blockAfterOpen = false;
      let bodyReads = 0;
      const trackedFileSystem = FileSystem.FileSystem.of({
        ...fs,
        open: (candidate, options) =>
          Effect.gen(function* () {
            if (candidate !== filePath) return yield* fs.open(candidate, options);
            let opened: FileSystem.File | undefined;
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                if (opened === undefined) return;
                active.delete(opened);
                yield* Queue.offer(closed, opened);
              }),
            );
            const file = yield* fs.open(candidate, options);
            opened = file;
            active.add(file);
            if (blockAfterOpen) {
              yield* Deferred.succeed(blocked, undefined);
              return yield* Effect.never;
            }
            return new Proxy(file, {
              get(target, key) {
                if (key === "readAlloc") {
                  return (size: number) => {
                    bodyReads += 1;
                    return target.readAlloc(size);
                  };
                }
                return Reflect.get(target, key, target);
              },
            });
          }),
      });
      const request = yield* makeStaticRequest(staticDir).pipe(
        Effect.provideService(FileSystem.FileSystem, trackedFileSystem),
      );

      const get = yield* request("/app.txt");
      expect(yield* get.text).toBe(body);
      yield* Queue.take(closed);
      expect(active.size).toBe(0);
      expect(bodyReads).toBeGreaterThan(0);
      const readsAfterGet = bodyReads;
      const head = yield* request("/app.txt", {
        method: "HEAD",
        headers: { "accept-encoding": "gzip" },
      });
      expect(head.status).toBe(200);
      expect(head.headers["content-encoding"]).toBe("gzip");
      expect(yield* head.text).toBe("");
      yield* Queue.take(closed);
      expect(active.size).toBe(0);
      expect(bodyReads).toBe(readsAfterGet);
      const unchanged = yield* request("/app.txt", {
        headers: { "if-none-match": get.headers["etag"]! },
      });
      expect(unchanged.status).toBe(304);
      yield* Queue.take(closed);
      expect(active.size).toBe(0);
      expect(bodyReads).toBe(readsAfterGet);

      blockAfterOpen = true;
      const cancelled = yield* request("/app.txt").pipe(Effect.forkChild);
      yield* Deferred.await(blocked);
      expect(active.size).toBe(1);
      yield* Fiber.interrupt(cancelled);
      yield* Queue.take(closed);
      expect(active.size).toBe(0);
    }),
  );
});

describe("video asset byte ranges", () => {
  it.effect("uses current descriptor metadata after an in-place truncate or extension", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-guarded-current-stat-" });
      const filePath = path.join(directory, "clip.mp4");
      for (const [contents, range, method, expected, status, contentRange] of [
        ["1234", undefined, "GET", "1234", 200, null],
        ["0123456789abcdef", undefined, "GET", "0123456789abcdef", 200, null],
        ["1234", "bytes=4-", "GET", "", 416, "bytes */4"],
        ["1234", "bytes=1-20", "GET", "234", 206, "bytes 1-3/4"],
        ["0123456789abcdef", "bytes=10-", "GET", "abcdef", 206, "bytes 10-15/16"],
        ["0123456789abcdef", undefined, "HEAD", "", 200, null],
        ["", undefined, "GET", "", 200, null],
        ["", "bytes=0-1", "GET", "", 416, "bytes */0"],
      ] as const) {
        yield* fs.writeFileString(filePath, "0123456789");
        const canonicalPath = yield* fs.realPath(filePath);
        const file = yield* openMediaFile(canonicalPath);
        if (!file) throw new Error("Expected an opened media file");
        yield* fs.writeFileString(filePath, contents);
        const response = HttpServerResponse.toWeb(
          yield* assetFileResponse(
            { path: canonicalPath, file, mimeType: "video/mp4" },
            range,
            undefined,
            method,
          ),
        );
        expect(response.status).toBe(status);
        expect(response.headers.get("content-range")).toBe(contentRange);
        if (status !== 416) {
          expect(response.headers.get("content-length")).toBe(
            String(method === "HEAD" ? contents.length : expected.length),
          );
        }
        expect(yield* Effect.promise(() => response.text())).toBe(expected);
      }
    }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect(
    "rejects unaddressable ranges before streaming and preserves small ranges on large files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-guarded-offset-limit-" });
        const filePath = path.join(directory, "clip.mp4");
        yield* fs.writeFileString(filePath, "0123456789");
        const canonicalPath = yield* fs.realPath(filePath);
        const unsafeOffset = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
        const size = unsafeOffset + 32n;
        for (const [range, status] of [
          [`bytes=${unsafeOffset}-${unsafeOffset}`, 416],
          [`bytes=0-${unsafeOffset}`, 416],
          ["bytes=-1", 416],
          [undefined, 413],
          ["bytes=0-1", 206],
        ] as const) {
          const file = yield* openMediaFile(canonicalPath);
          if (!file) throw new Error("Expected an opened media file");
          const info = yield* Effect.promise(() => file.handle.stat({ bigint: true }));
          info.size = size;
          const statSpy = vi.spyOn(file.handle, "stat").mockResolvedValue(info);
          yield* Effect.addFinalizer(() => Effect.sync(() => statSpy.mockRestore()));
          const response = HttpServerResponse.toWeb(
            yield* assetFileResponse({ path: canonicalPath, file, mimeType: "video/mp4" }, range),
          );
          expect(response.status).toBe(status);
          if (status === 416) {
            expect(response.headers.get("content-range")).toBe(`bytes */${size}`);
            expect(yield* Effect.promise(() => response.text())).toBe("");
          } else if (status === 206) {
            expect(response.headers.get("content-range")).toBe(`bytes 0-1/${size}`);
            expect(yield* Effect.promise(() => response.text())).toBe("01");
          } else {
            expect(yield* Effect.promise(() => response.text())).toBe(
              "File is too large to preview.",
            );
          }
        }
      }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect("keeps attachment media out of the cache once its signed URL expires", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-attachment-media-" });
      const filePath = path.join(directory, "audio.wav");
      yield* fs.writeFileString(filePath, "RIFF");
      const canonicalPath = yield* fs.realPath(filePath);
      const response = HttpServerResponse.toWeb(
        yield* assetFileResponse({ path: canonicalPath, mimeType: "audio/wav" }),
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
    }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect("closes guarded descriptors after full, HEAD, rejected, and cancelled responses", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-guarded-cleanup-" });
      const filePath = path.join(directory, "clip.mp4");
      const bytes = new Uint8Array(1024 * 1024).fill(42);
      yield* fs.writeFile(filePath, bytes);
      const canonicalPath = yield* fs.realPath(filePath);
      for (const mode of ["full", "HEAD", "rejected", "cancelled"] as const) {
        const file = yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* openMediaFile(canonicalPath);
            if (!file) throw new Error("Expected an opened media file");
            const response = HttpServerResponse.toWeb(
              yield* assetFileResponse(
                { path: canonicalPath, file, mimeType: "video/mp4" },
                mode === "rejected" ? `bytes=${bytes.length}-` : "bytes=0-",
                undefined,
                mode === "HEAD" ? "HEAD" : "GET",
              ),
            );
            if (mode === "HEAD") {
              expect(response.status).toBe(200);
              expect(response.headers.get("content-length")).toBe(String(bytes.length));
              expect(response.headers.get("content-range")).toBeNull();
              expect(yield* Effect.promise(() => response.text())).toBe("");
            } else if (mode === "rejected") {
              expect(response.status).toBe(416);
              expect(yield* Effect.promise(() => response.text())).toBe("");
            } else if (mode === "cancelled") {
              const reader = response.body!.getReader();
              const first = yield* Effect.promise(() => reader.read());
              expect(first.done).toBe(false);
              expect(first.value!.byteLength).toBeLessThan(bytes.length);
              yield* Effect.promise(() => reader.cancel());
            } else {
              expect(yield* Effect.promise(() => response.arrayBuffer())).toEqual(bytes.buffer);
            }
            return file;
          }),
        );
        expect(file.handle.fd).toBe(-1);
      }
    }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect("streams exactly the requested bytes and leaves full downloads intact", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-video-range-" });
      const file = path.join(directory, "clip.mp4");
      yield* fs.writeFileString(file, "0123456789");
      const asset = { path: file, mimeType: "video/mp4" };
      for (const [header, expected, contentRange] of [
        ["bytes=0-1", "01", "bytes 0-1/10"],
        ["bytes=4-", "456789", "bytes 4-9/10"],
        ["bytes=-3", "789", "bytes 7-9/10"],
        ["bytes=-999999999999999999999999", "0123456789", "bytes 0-9/10"],
        ["bytes=8-999999999999999999999999", "89", "bytes 8-9/10"],
      ] as const) {
        const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset, header));
        expect(response.status).toBe(206);
        expect(response.headers.get("accept-ranges")).toBe("bytes");
        expect(response.headers.get("content-range")).toBe(contentRange);
        expect(response.headers.get("content-length")).toBe(String(expected.length));
        expect(yield* Effect.promise(() => response.text())).toBe(expected);
      }
      for (const header of [
        undefined,
        "items=0-1",
        "bytes=0-1,4-5",
        "bytes=8-2",
        "bytes=-",
        "bytes=bad",
      ]) {
        const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset, header));
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.text())).toBe("0123456789");
      }
      const conditional = HttpServerResponse.toWeb(
        yield* assetFileResponse(asset, "bytes=0-1", '"old-etag"'),
      );
      expect(conditional.status).toBe(200);
      expect(yield* Effect.promise(() => conditional.text())).toBe("0123456789");
      const uppercase = HttpServerResponse.toWeb(
        yield* assetFileResponse({ ...asset, mimeType: "Video/MP4" }, "bytes=0-1"),
      );
      expect(uppercase.status).toBe(206);
      expect(yield* Effect.promise(() => uppercase.text())).toBe("01");
      const image = HttpServerResponse.toWeb(
        yield* assetFileResponse({ path: file, mimeType: "image/png" }, "bytes=0-1"),
      );
      expect(image.status).toBe(206);
      expect(image.headers.get("accept-ranges")).toBe("bytes");
      expect(yield* Effect.promise(() => image.text())).toBe("01");
      for (const mimeType of ["text/plain", "text/csv", "application/octet-stream"]) {
        for (const [range, expected, status] of [
          ["bytes=2-5", "2345", 206],
          ["bytes=-3", "789", 206],
          ["bytes=10-", "", 416],
        ] as const) {
          const result = HttpServerResponse.toWeb(
            yield* assetFileResponse({ path: file, mimeType }, range),
          );
          expect(result.status).toBe(status);
          expect(yield* Effect.promise(() => result.text())).toBe(expected);
        }
      }
    }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect(
    "supports native audio header probes and seeking without changing explicit downloads",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-audio-range-" });
        const file = path.join(directory, "recording.wav");
        yield* fs.writeFileString(file, "0123456789");
        const asset = { path: file, mimeType: "audio/wav" };
        for (const [header, expected] of [
          ["bytes=0-1", "01"],
          ["bytes=5-", "56789"],
        ] as const) {
          const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset, header));
          expect(response.status).toBe(206);
          expect(response.headers.get("content-type")).toBe("audio/wav");
          expect(response.headers.get("accept-ranges")).toBe("bytes");
          expect(response.headers.get("content-length")).toBe(String(expected.length));
          expect(yield* Effect.promise(() => response.text())).toBe(expected);
        }
        const download = HttpServerResponse.toWeb(
          yield* assetFileResponse({ ...asset, download: true, fileName: "recording.wav" }),
        );
        expect(download.status).toBe(200);
        expect(download.headers.get("content-disposition")).toContain("attachment;");
        expect(yield* Effect.promise(() => download.text())).toBe("0123456789");
      }).pipe(Effect.provide(layerFileResponse)),
  );

  it.effect("rejects ranges outside the file, including empty files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-video-range-" });
      const file = path.join(directory, "clip.mp4");
      yield* fs.writeFileString(file, "0123456789");
      for (const header of ["bytes=10-", "bytes=-0", "bytes=999999999999999999999999-"]) {
        const response = HttpServerResponse.toWeb(
          yield* assetFileResponse({ path: file, mimeType: "video/mp4" }, header),
        );
        expect(response.status).toBe(416);
        expect(response.headers.get("content-range")).toBe("bytes */10");
        expect(yield* Effect.promise(() => response.text())).toBe("");
      }
      yield* fs.writeFileString(file, "");
      const empty = HttpServerResponse.toWeb(
        yield* assetFileResponse({ path: file, mimeType: "video/mp4" }, "bytes=0-1"),
      );
      expect(empty.status).toBe(416);
      expect(empty.headers.get("content-range")).toBe("bytes */0");
    }).pipe(Effect.provide(layerFileResponse)),
  );
});

describe("assetResponseHeaders", () => {
  it("sandboxes SVG and other XML assets", () => {
    expect(assetResponseHeaders("/attachments/user-image.svg")).toMatchObject({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
    expect(assetResponseHeaders("/attachments/user-image.SVG")).toHaveProperty(
      "Content-Security-Policy",
    );
    for (const name of ["page.xhtml", "page.XHT", "feed.xml", "sheet.xsl", "feed.rss"]) {
      expect(assetResponseHeaders(`/workspace/${name}`)).toHaveProperty(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
    }
    expect(assetResponseHeaders("/workspace/photo.png")).not.toHaveProperty(
      "Content-Security-Policy",
    );
  });

  it("chooses the sandbox from the same type it serves", () => {
    for (const name of ["page.html", "page.HTM", "page.shtml"]) {
      expect(assetResponseHeaders(`/workspace/${name}`)).toMatchObject({
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-downloads",
      });
    }
    expect(assetResponseHeaders("/workspace/page.xhtml")).toMatchObject({
      "Content-Type": "application/xhtml+xml",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    expect(assetResponseHeaders("/workspace/report.docx")).toHaveProperty(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(assetResponseHeaders("/attachments/upload.bin")).toHaveProperty(
      "Content-Type",
      "application/octet-stream",
    );
  });
  it("serves inline attachment documents with their declared mime type", () => {
    expect(
      assetResponseHeaders("/attachments/upload.bin", { mimeType: "application/pdf" }),
    ).toMatchObject({
      "Content-Type": "application/pdf",
    });
    expect(
      assetResponseHeaders("/attachments/upload.bin", { mimeType: "text/html" }),
    ).toMatchObject({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-downloads",
    });
  });

  it("downloads uploaded documents without executing their content", () => {
    expect(assetResponseHeaders("/attachments/upload.html", { download: true })).toMatchObject({
      "Content-Disposition": "attachment",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": "application/octet-stream",
    });
  });

  it("serves the real filename and mime type when the claims carry them", () => {
    expect(
      assetResponseHeaders("/attachments/thread-1-abc-pdf.pdf", {
        download: true,
        fileName: "Q3 report.pdf",
        mimeType: "application/pdf",
      }),
    ).toMatchObject({
      "Content-Disposition": 'attachment; filename="Q3 report.pdf"',
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": "application/pdf",
    });
  });

  it("keeps renderable mime types as octet-stream downloads", () => {
    for (const mimeType of [
      "text/html",
      "text/xml",
      "image/svg+xml",
      "application/xhtml+xml",
      "application/rss+xml",
      "APPLICATION/XML",
      "IMAGE/SVG+XML",
      "application/xml-dtd",
      "application/xml-external-parsed-entity",
      "not a mime",
    ]) {
      expect(
        assetResponseHeaders("/attachments/upload.bin", { download: true, mimeType }),
      ).toHaveProperty("Content-Type", "application/octet-stream");
    }
  });
});

describe("downloadContentDisposition", () => {
  it("quotes plain names and strips quotes and control characters", () => {
    expect(downloadContentDisposition("report.pdf")).toBe('attachment; filename="report.pdf"');
    expect(downloadContentDisposition('we"ird\n.pdf')).toBe('attachment; filename="we_ird_.pdf"');
  });

  it("adds an RFC 5987 encoded name for non-ASCII filenames", () => {
    expect(downloadContentDisposition("répört.pdf")).toBe(
      `attachment; filename="r_p_rt.pdf"; filename*=UTF-8''r%C3%A9p%C3%B6rt.pdf`,
    );
    expect(downloadContentDisposition("résumé'(*).pdf")).toBe(
      `attachment; filename="r_sum_'(*).pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%27%28%2A%29.pdf`,
    );
  });

  it("does not throw on unpaired surrogates in the filename", () => {
    expect(downloadContentDisposition("bad\ud800name.pdf")).toBe(
      `attachment; filename="bad_name.pdf"; filename*=UTF-8''bad%EF%BF%BDname.pdf`,
    );
  });
});
