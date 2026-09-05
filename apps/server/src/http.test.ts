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
import * as Queue from "effect/Queue";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerResponse,
} from "effect/unstable/http";
import { openMediaFile } from "./assets/MediaFile.ts";

import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";

import * as ServerConfig from "./config.ts";

import {
  assetResponseHeaders,
  browserApiCorsLayer,
  assetFileResponse,
  downloadContentDisposition,
  httpCompressionLayer,
  isLoopbackHostname,
  resolveDevRedirectUrl,
  staticAndDevRouteLayer,
} from "./http.ts";

describe("browser API CORS", () => {
  it("accepts protocol negotiation with authenticated browser headers", async () => {
    const routeLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        yield* router.add("GET", "/api/environment", HttpServerResponse.empty());
      }),
    );
    const appLayer = Layer.merge(routeLayer, browserApiCorsLayer).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "http-cors-test-" })),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(appLayer, { disableLogger: true });

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

const fileResponseLayer = Layer.mergeAll(NodeHttpPlatform.layer, NodeServices.layer);

const makeStaticRequest = Effect.fn("HttpTest.makeStaticRequest")(function* (staticDir: string) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const appLayer = Layer.merge(staticAndDevRouteLayer, httpCompressionLayer).pipe(
    Layer.provideMerge(ServerConfig.layer({ ...config, staticDir })),
    Layer.provideMerge(NodeHttpPlatform.layer),
    Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, fileSystem)),
    Layer.provideMerge(Layer.succeed(Path.Path, path)),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(appLayer, { disableListenLog: true }).pipe(
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
                  return (size: FileSystem.SizeInput) => {
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
    }).pipe(Effect.provide(fileResponseLayer)),
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
          // Model a sparse file beyond the native stream's numeric addressing limit.
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
      }).pipe(Effect.provide(fileResponseLayer)),
  );

  it.effect("streams guarded file ranges, including suffixes and conditional requests", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-guarded-range-" });
      const filePath = path.join(directory, "clip.mp4");
      yield* fs.writeFileString(filePath, "0123456789");
      const canonicalPath = yield* fs.realPath(filePath);
      for (const [range, ifRange, expected, status, contentRange] of [
        [undefined, undefined, "0123456789", 200, null],
        ["bytes=0-1", undefined, "01", 206, "bytes 0-1/10"],
        ["bytes=4-", undefined, "456789", 206, "bytes 4-9/10"],
        ["bytes=-3", undefined, "789", 206, "bytes 7-9/10"],
        ["bytes=-999999999999999999999999", undefined, "0123456789", 206, "bytes 0-9/10"],
        ["bytes=10-", undefined, "", 416, "bytes */10"],
        ["bytes=0-1", '"old-etag"', "0123456789", 200, null],
        ["bytes=0-1", "", "0123456789", 200, null],
      ] as const) {
        const file = yield* openMediaFile(canonicalPath);
        if (!file) throw new Error("Expected an opened media file");
        const response = HttpServerResponse.toWeb(
          yield* assetFileResponse(
            { path: canonicalPath, file, mimeType: "video/mp4" },
            range,
            ifRange,
          ),
        );
        expect(response.status).toBe(status);
        expect(response.headers.get("accept-ranges")).toBe("bytes");
        expect(response.headers.get("content-range")).toBe(contentRange);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.headers.get("etag")).toBeNull();
        expect(response.headers.get("last-modified")).toBeNull();
        if (status !== 416)
          expect(response.headers.get("content-length")).toBe(String(expected.length));
        expect(yield* Effect.promise(() => response.text())).toBe(expected);
      }
    }).pipe(Effect.provide(fileResponseLayer)),
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
    }).pipe(Effect.provide(fileResponseLayer)),
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
      expect(image.status).toBe(200);
      expect(image.headers.has("accept-ranges")).toBe(false);
      expect(yield* Effect.promise(() => image.text())).toBe("0123456789");
    }).pipe(Effect.provide(fileResponseLayer)),
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
    }).pipe(Effect.provide(fileResponseLayer)),
  );
});

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("assetResponseHeaders", () => {
  it("sandboxes SVG assets", () => {
    expect(assetResponseHeaders("/attachments/user-image.svg")).toMatchObject({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
    expect(assetResponseHeaders("/attachments/user-image.SVG")).toHaveProperty(
      "Content-Security-Policy",
    );
  });

  it("does not apply document policy to raster images", () => {
    expect(assetResponseHeaders("/attachments/user-image.png")).toEqual({
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("serves inline videos with their declared mime type", () => {
    expect(
      assetResponseHeaders("/attachments/demo.bin", {
        mimeType: 'video/mp4; codecs="avc1.42E01E"',
      }),
    ).toEqual({
      "Cache-Control": "private, max-age=3600",
      "Content-Type": "video/mp4",
      "X-Content-Type-Options": "nosniff",
    });
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
      "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals",
    });
  });
  it("serves HTML assets as utf-8 inside a sandboxed origin", () => {
    for (const path of ["/workspace/page.html", "/workspace/PAGE.HTM", "/tmp/report.html"]) {
      expect(assetResponseHeaders(path)).toMatchObject({
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-modals",
      });
    }
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

  it("preserves official Office Open XML mime types", () => {
    for (const mimeType of [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ]) {
      expect(
        assetResponseHeaders("/attachments/upload.bin", { download: true, mimeType }),
      ).toHaveProperty("Content-Type", mimeType);
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
