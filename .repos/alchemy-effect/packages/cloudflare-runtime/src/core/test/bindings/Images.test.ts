// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Adapted from Miniflare's images plugin tests
 * (`workers-sdk/packages/miniflare/test/plugins/images/index.spec.ts`).
 *
 * Every upstream case is ported (hosted CRUD + local delivery). Upstream has
 * no coverage for the Sharp transform path (`input(...).transform(...)
 * .output(...)` / `info(...)`), so this suite adds cases pinning the
 * documented local-mode fidelity of the ported fetcher
 * (`workers-sdk/packages/miniflare/src/plugins/images/fetcher.ts`):
 * resize/rotate/transcode happy paths, the 415 GIF and RGB/RGBA output
 * errors (code 9520), draws/overlays being ignored, and info() for bitmap
 * and SVG inputs. A file-system persistence case is added for parity with
 * the other binding suites.
 *
 * Fixture images are checked-in base64 constants (generated once with
 * Sharp), never produced at test time.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import sharp from "sharp";
import * as Images from "../../bindings/images/index.ts";
import * as Docker from "../../Docker.ts";
import * as Globals from "../../globals/Globals.ts";
import * as Internet from "../../globals/Internet.ts";
import * as Storage from "../../globals/Storage.ts";
import * as Paths from "../../internal/Paths.ts";
import * as Runtime from "../../Runtime.ts";
import * as RuntimeServices from "../../RuntimeServices.ts";
import * as Workerd from "../../workerd/Workerd.ts";
import type { TestWorker } from "../helpers/runtime.ts";
import {
  localRuntimeLayer,
  makeTempDirectory,
  startTestWorker,
} from "../helpers/runtime.ts";

// -----------------------------------------------------------------------------
// Fixtures (checked-in, generated once with Sharp)
// -----------------------------------------------------------------------------

/** 8x4 solid red PNG. */
const PNG_RED_8X4 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGP4z8CAFWEXJUsCAFpeH+EeQoQoAAAAAElFTkSuQmCC";

/** 8x4 solid green JPEG. */
const JPEG_GREEN_8X4 =
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAEAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAB//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ALoAfAr/2Q==";

/** 4x4 solid blue GIF (used as an overlay for the draws-ignored case). */
const GIF_BLUE_4X4 =
  "R0lGODlhBAAEAIAAAExpcQAA/yH5BAUAAAAALAAAAAAEAAQAAAIEjI8ZBQA7";

/** Minimal SVG (SVG inputs report format only and are never transformed). */
const SVG_FIXTURE = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>`;

const decodeBase64 = (value: string) =>
  Uint8Array.from(Buffer.from(value, "base64"));

// The worker stores and retrieves bytes without validation, so hosted CRUD
// cases don't need a real image (mirrors upstream).
const TEST_IMAGE_BYTES = new Uint8Array([1, 2, 3, 4, 5]);

// -----------------------------------------------------------------------------
// Test worker: hosted CRUD over a `/cmd` op protocol (ported from upstream's
// WORKER_SCRIPT) plus one route per transform/info scenario, driving
// `env.IMAGES`.
// -----------------------------------------------------------------------------

const TEST_SCRIPT = `
const OVERLAY_GIF = "${GIF_BLUE_4X4}";

function decodeBase64(value) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

async function handleCommand(images, op, args) {
  const hosted = images.hosted;
  switch (op) {
    case "upload": {
      const bytes = new Uint8Array(args.bytes);
      return hosted.upload(bytes.buffer, args.options);
    }
    case "bytes": {
      const stream = await hosted.image(args.id).bytes();
      if (stream === null) return null;
      const buffer = await new Response(stream).arrayBuffer();
      return Array.from(new Uint8Array(buffer));
    }
    case "details":
      return hosted.image(args.id).details();
    case "update":
      return hosted.image(args.id).update(args.options);
    case "delete":
      return hosted.image(args.id).delete();
    case "list":
      return hosted.list(args.options);
    default:
      throw new Error("Unknown op: " + op);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/cmd") {
        try {
          const { op, args } = await request.json();
          const result = await handleCommand(env.IMAGES, op, args || {});
          return Response.json({ ok: true, result });
        } catch (err) {
          return Response.json({ ok: false, error: err.message }, { status: 200 });
        }
      }

      if (url.pathname === "/info") {
        try {
          const info = await env.IMAGES.info(request.body);
          return Response.json({ ok: true, info });
        } catch (err) {
          return Response.json(
            { ok: false, code: err.code, message: err.message },
            { status: 200 },
          );
        }
      }

      if (url.pathname === "/transform") {
        const transform = {};
        for (const key of ["width", "height", "rotate"]) {
          const value = url.searchParams.get(key);
          if (value !== null) transform[key] = Number(value);
        }
        const format = url.searchParams.get("format");
        try {
          const result = await env.IMAGES.input(request.body)
            .transform(transform)
            .output({ format });
          return result.response();
        } catch (err) {
          return Response.json(
            { error: true, code: err.code, message: err.message },
            { status: 200 },
          );
        }
      }

      if (url.pathname === "/draw") {
        // Draw a 4x4 blue overlay onto the input; local mode documents that
        // draws are ignored (only the root image's transforms apply).
        const overlay = new Blob([decodeBase64(OVERLAY_GIF)]).stream();
        const result = await env.IMAGES.input(request.body)
          .transform({ width: 4 })
          .draw(overlay, { top: 0, left: 0 })
          .output({ format: "image/png" });
        return result.response();
      }

      return new Response("not found", { status: 404 });
    } catch (e) {
      return new Response("Test worker error: " + (e?.stack ?? String(e)), { status: 500 });
    }
  },
};
`;

const startImagesTestWorker = (name: string) =>
  startTestWorker({
    name,
    compatibilityDate: "2025-04-01",
    compatibilityFlags: [],
    modules: [{ name: "main.js", type: "ESModule", content: TEST_SCRIPT }],
    bindings: [Images.local({ binding: "IMAGES" })],
  });

interface CmdEnvelope<T> {
  ok: boolean;
  result: T;
  error?: string;
}

const sendCmd = <T>(
  worker: TestWorker,
  op: string,
  args: Record<string, unknown> = {},
) =>
  worker
    .fetchJson<CmdEnvelope<T>>("/cmd", {
      method: "POST",
      body: JSON.stringify({ op, args }),
      headers: { "Content-Type": "application/json" },
    })
    .pipe(
      Effect.flatMap((data) =>
        data.ok
          ? Effect.succeed(data.result)
          : Effect.die(new Error(data.error)),
      ),
    );

const upload = (
  worker: TestWorker,
  bytes: Uint8Array,
  options?: Record<string, unknown>,
) =>
  sendCmd<ImageMetadata>(worker, "upload", {
    bytes: Array.from(bytes),
    options,
  });

/** POST raw image bytes to a transform/info route. */
const postBytes = (
  worker: TestWorker,
  path: string,
  bytes: Uint8Array | string,
) => worker.fetch(path, { method: "POST", body: bytes });

const metadataOf = (buffer: ArrayBuffer) =>
  Effect.promise(() => sharp(buffer).metadata());

interface ImageMetadata {
  id: string;
  filename: string;
  uploaded: string;
  requireSignedURLs: boolean;
  meta: Record<string, unknown>;
  variants: Array<string>;
  creator?: string;
}

interface ImageList {
  images: Array<ImageMetadata>;
  cursor?: string;
  listComplete: boolean;
}

layer(localRuntimeLayer, { excludeTestServices: true })(
  "Images binding",
  (it) => {
    // ---------------------------------------------------------------------------
    // Transforms (Sharp over the loopback)
    // ---------------------------------------------------------------------------

    it.effect("resizes an image", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-resize");
        const res = yield* postBytes(
          worker,
          "/transform?width=4&format=image/png",
          decodeBase64(PNG_RED_8X4),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        const metadata = yield* metadataOf(
          yield* Effect.promise(() => res.arrayBuffer()),
        );
        expect(metadata.format).toBe("png");
        // fit: "contain" preserves the 2:1 aspect ratio.
        expect(metadata.width).toBe(4);
        expect(metadata.height).toBe(2);
      }),
    );

    it.effect("rotates an image", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-rotate");
        const res = yield* postBytes(
          worker,
          "/transform?rotate=90&format=image/png",
          decodeBase64(PNG_RED_8X4),
        );
        expect(res.status).toBe(200);
        const metadata = yield* metadataOf(
          yield* Effect.promise(() => res.arrayBuffer()),
        );
        expect(metadata.width).toBe(4);
        expect(metadata.height).toBe(8);
      }),
    );

    it.effect("transcodes an image (PNG -> WebP, JPEG -> AVIF)", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-transcode");
        const webpRes = yield* postBytes(
          worker,
          "/transform?format=image/webp",
          decodeBase64(PNG_RED_8X4),
        );
        expect(webpRes.status).toBe(200);
        expect(webpRes.headers.get("content-type")).toBe("image/webp");
        const webp = yield* metadataOf(
          yield* Effect.promise(() => webpRes.arrayBuffer()),
        );
        expect(webp.format).toBe("webp");
        expect(webp.width).toBe(8);
        expect(webp.height).toBe(4);

        const avifRes = yield* postBytes(
          worker,
          "/transform?format=image/avif",
          decodeBase64(JPEG_GREEN_8X4),
        );
        expect(avifRes.status).toBe(200);
        expect(avifRes.headers.get("content-type")).toBe("image/avif");
        const avif = yield* metadataOf(
          yield* Effect.promise(() => avifRes.arrayBuffer()),
        );
        expect(avif.format).toBe("heif");
      }),
    );

    it.effect(
      "GIF output fails with the documented local-mode 415 (code 9520)",
      () =>
        Effect.gen(function* () {
          const worker = yield* startImagesTestWorker("images-gif-415");
          const body = yield* worker.fetchJson<{
            error: true;
            code: number;
            message: string;
          }>("/transform?format=image/gif", {
            method: "POST",
            body: decodeBase64(PNG_RED_8X4),
          });
          expect(body.error).toBe(true);
          expect(body.code).toBe(9520);
          expect(body.message).toContain(
            "GIF output is not supported in local mode",
          );
        }),
    );

    it.effect(
      "RGB/RGBA output fails with the documented local-mode 415 (code 9520)",
      () =>
        Effect.gen(function* () {
          const worker = yield* startImagesTestWorker("images-rgb-415");
          const body = yield* worker.fetchJson<{
            error: true;
            code: number;
            message: string;
          }>("/transform?format=rgba", {
            method: "POST",
            body: decodeBase64(PNG_RED_8X4),
          });
          expect(body.error).toBe(true);
          expect(body.code).toBe(9520);
          expect(body.message).toContain(
            "RGB/RGBA output is not supported in local mode",
          );
        }),
    );

    it.effect("draws/overlays are ignored in local mode", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-draw-ignored");
        const res = yield* postBytes(
          worker,
          "/draw",
          decodeBase64(PNG_RED_8X4),
        );
        expect(res.status).toBe(200);
        const buffer = yield* Effect.promise(() => res.arrayBuffer());
        const metadata = yield* metadataOf(buffer);
        // Only the root image's resize applied (8x4 -> 4x2); the 4x4 overlay
        // was skipped entirely, so the output stays solid red.
        expect(metadata.format).toBe("png");
        expect(metadata.width).toBe(4);
        expect(metadata.height).toBe(2);
        const raw = yield* Effect.promise(() => sharp(buffer).raw().toBuffer());
        expect([raw[0], raw[1], raw[2]]).toEqual([255, 0, 0]);
      }),
    );

    it.effect("info() reports format and dimensions for bitmap input", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-info");
        const body = yield* worker.fetchJson<{
          ok: boolean;
          info: {
            format: string;
            fileSize: number;
            width: number;
            height: number;
          };
        }>("/info", { method: "POST", body: decodeBase64(PNG_RED_8X4) });
        expect(body.ok).toBe(true);
        expect(body.info.format).toBe("image/png");
        expect(body.info.width).toBe(8);
        expect(body.info.height).toBe(4);
        expect(body.info.fileSize).toBeGreaterThan(0);
      }),
    );

    it.effect("info() reports format only for SVG input", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-info-svg");
        const body = yield* worker.fetchJson<{
          ok: boolean;
          info: Record<string, unknown>;
        }>("/info", { method: "POST", body: SVG_FIXTURE });
        expect(body.ok).toBe(true);
        expect(body.info).toEqual({ format: "image/svg+xml" });
      }),
    );

    it.effect("info() reports image/avif for AVIF input", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-info-avif");
        // libvips has no AVIF fixture format of its own here — transcode one
        // first, then feed it back through info().
        const avifRes = yield* postBytes(
          worker,
          "/transform?format=image/avif",
          decodeBase64(JPEG_GREEN_8X4),
        );
        expect(avifRes.status).toBe(200);
        const avif = new Uint8Array(
          yield* Effect.promise(() => avifRes.arrayBuffer()),
        );

        const body = yield* worker.fetchJson<{
          ok: boolean;
          info: {
            format: string;
            fileSize: number;
            width: number;
            height: number;
          };
        }>("/info", { method: "POST", body: avif });
        expect(body.ok).toBe(true);
        // sharp reports AVIF as `heif` + compression `av1`.
        expect(body.info.format).toBe("image/avif");
        expect(body.info.width).toBe(8);
        expect(body.info.height).toBe(4);
        expect(body.info.fileSize).toBeGreaterThan(0);
      }),
    );

    // ---------------------------------------------------------------------------
    // Local delivery (upstream "Images local delivery")
    // ---------------------------------------------------------------------------

    it.effect(
      "variant URLs are absolute and use /cdn-cgi/mf/imagedelivery/ path",
      () =>
        Effect.gen(function* () {
          const worker = yield* startImagesTestWorker("images-variant-url");
          const metadata = yield* upload(worker, TEST_IMAGE_BYTES, {
            id: "variant-test",
          });
          expect(metadata.variants).toHaveLength(1);
          expect(metadata.variants[0]).toBe(
            `${worker.baseUrl.origin}/cdn-cgi/mf/imagedelivery/variant-test/public`,
          );
        }),
    );

    it.effect("image delivery endpoint serves image bytes", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-delivery");
        yield* upload(worker, TEST_IMAGE_BYTES, { id: "delivery-test" });

        const response = yield* worker.fetch(
          "/cdn-cgi/mf/imagedelivery/delivery-test/public",
        );
        expect(response.status).toBe(200);
        const data = new Uint8Array(
          yield* Effect.promise(() => response.arrayBuffer()),
        );
        expect(data).toEqual(TEST_IMAGE_BYTES);
      }),
    );

    it.effect("delivered images carry the detected content type", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker(
          "images-delivery-content-type",
        );
        yield* upload(worker, decodeBase64(PNG_RED_8X4), {
          id: "content-type-test",
        });

        const response = yield* worker.fetch(
          "/cdn-cgi/mf/imagedelivery/content-type-test/public",
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/png");
        yield* Effect.promise(() => response.arrayBuffer());
      }),
    );

    it.effect("image delivery returns 404 for non-existent image", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-delivery-404");
        const response = yield* worker.fetch(
          "/cdn-cgi/mf/imagedelivery/does-not-exist/public",
        );
        expect(response.status).toBe(404);
        yield* Effect.promise(() => response.arrayBuffer());
      }),
    );

    // ---------------------------------------------------------------------------
    // Hosted CRUD (upstream "Images hosted CRUD")
    // ---------------------------------------------------------------------------

    it.effect("upload and retrieve metadata", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-crud-upload");
        const metadata = yield* upload(worker, TEST_IMAGE_BYTES, {
          id: "test-123",
        });
        expect(metadata.id).toBe("test-123");
        expect(metadata.filename).toBe("uploaded.jpg");
        expect(metadata.requireSignedURLs).toBe(false);
      }),
    );

    it.effect("upload and retrieve image data", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-crud-bytes");
        yield* upload(worker, TEST_IMAGE_BYTES, { id: "blob-test" });
        const data = yield* sendCmd<Array<number>>(worker, "bytes", {
          id: "blob-test",
        });
        expect(new Uint8Array(data)).toEqual(TEST_IMAGE_BYTES);
      }),
    );

    it.effect("upload with base64 encoding", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-crud-base64");
        const base64String = btoa(String.fromCharCode(...TEST_IMAGE_BYTES));
        const base64Bytes = new TextEncoder().encode(base64String);

        const metadata = yield* upload(worker, base64Bytes, {
          id: "base64-test",
          encoding: "base64",
        });
        expect(metadata.id).toBe("base64-test");

        const data = yield* sendCmd<Array<number>>(worker, "bytes", {
          id: "base64-test",
        });
        expect(new Uint8Array(data)).toEqual(TEST_IMAGE_BYTES);
      }),
    );

    it.effect("get details for non-existent image returns null", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-crud-details-null");
        const metadata = yield* sendCmd<ImageMetadata | null>(
          worker,
          "details",
          {
            id: "does-not-exist",
          },
        );
        expect(metadata).toBe(null);
      }),
    );

    it.effect("get image data for non-existent image returns null", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-crud-bytes-null");
        const data = yield* sendCmd<Array<number> | null>(worker, "bytes", {
          id: "does-not-exist",
        });
        expect(data).toBe(null);
      }),
    );

    it.effect("update image metadata", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-crud-update");
        yield* upload(worker, TEST_IMAGE_BYTES, { id: "update-test" });
        const metadata = yield* sendCmd<ImageMetadata>(worker, "update", {
          id: "update-test",
          options: { requireSignedURLs: true },
        });
        expect(metadata.requireSignedURLs).toBe(true);
      }),
    );

    it.effect("delete image", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-crud-delete");
        yield* upload(worker, TEST_IMAGE_BYTES, { id: "delete-test" });

        const deleted = yield* sendCmd<boolean>(worker, "delete", {
          id: "delete-test",
        });
        expect(deleted).toBe(true);

        const metadata = yield* sendCmd<ImageMetadata | null>(
          worker,
          "details",
          {
            id: "delete-test",
          },
        );
        expect(metadata).toBe(null);
      }),
    );

    it.effect("delete non-existent image returns false", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker(
          "images-crud-delete-missing",
        );
        const deleted = yield* sendCmd<boolean>(worker, "delete", {
          id: "does-not-exist",
        });
        expect(deleted).toBe(false);
      }),
    );

    // Upstream creates a fresh Miniflare per test; here every test shares one
    // runtime (and so one hosted store), so the list cases scope their reads by
    // a unique `creator` instead of asserting over the whole store.
    it.effect("list images", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-crud-list");
        yield* upload(worker, TEST_IMAGE_BYTES, {
          id: "list-1",
          creator: "list-solo",
        });

        const list = yield* sendCmd<ImageList>(worker, "list", {
          options: { creator: "list-solo" },
        });
        expect(list.listComplete).toBe(true);
        expect(list.images).toHaveLength(1);
        expect(list.images[0].id).toBe("list-1");
      }),
    );

    it.effect("list images filtered by creator", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-crud-list-creator");
        yield* upload(worker, TEST_IMAGE_BYTES, {
          id: "img1",
          creator: "socrates",
        });
        yield* upload(worker, TEST_IMAGE_BYTES, {
          id: "img2",
          creator: "plato",
        });

        const list = yield* sendCmd<ImageList>(worker, "list", {
          options: { creator: "plato" },
        });
        expect(list.images).toHaveLength(1);
        expect(list.images[0].id).toBe("img2");
      }),
    );

    it.effect("list images with cursor pagination", () =>
      Effect.gen(function* () {
        const worker = yield* startImagesTestWorker("images-crud-list-cursor");
        for (const id of ["page-1", "page-2", "page-3", "page-4", "page-5"]) {
          yield* upload(worker, TEST_IMAGE_BYTES, { id, creator: "paginate" });
        }

        const page1 = yield* sendCmd<ImageList>(worker, "list", {
          options: { limit: 2, creator: "paginate" },
        });
        expect(page1.images).toHaveLength(2);
        expect(page1.listComplete).toBe(false);
        expect(page1.cursor).toBeDefined();

        const page2 = yield* sendCmd<ImageList>(worker, "list", {
          options: { limit: 2, creator: "paginate", cursor: page1.cursor },
        });
        expect(page2.images).toHaveLength(2);
        expect(page2.listComplete).toBe(false);
        expect(page2.cursor).toBeDefined();

        const page3 = yield* sendCmd<ImageList>(worker, "list", {
          options: { limit: 2, creator: "paginate", cursor: page2.cursor },
        });
        expect(page3.images).toHaveLength(1);
        expect(page3.listComplete).toBe(true);

        const allIds = [
          ...page1.images.map((i) => i.id),
          ...page2.images.map((i) => i.id),
          ...page3.images.map((i) => i.id),
        ];
        expect(new Set(allIds).size).toBe(5);
      }),
    );
  },
);

// Every `layer(localRuntimeLayer)` block above shares one runtime; the CRUD
// cases use unique image ids so the shared hosted store never collides.

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

describe("Images binding persistence", () => {
  it.effect(
    "persists hosted images on file-system",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const tmp = yield* makeTempDirectory("images-persist-");

        const runtimeLayerTempDir = Runtime.RuntimeLive.pipe(
          Layer.provideMerge(RuntimeServices.layerLocalBindings()),
          Layer.provide(Globals.GlobalsLive),
          Layer.provideMerge(RuntimeServices.layerLoopback()),
          Layer.provide(Storage.layerDisk(tmp)),
          Layer.provide(Internet.InternetLive),
          Layer.provideMerge(RuntimeServices.layerRegistry()),
          Layer.provide(Paths.PathsLive),
          Layer.provide(Docker.DockerLive),
          Layer.provide(Workerd.WorkerdLive),
          Layer.provideMerge(
            Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer),
          ),
        );

        const runAgainstStorage = Effect.fn(
          function* (run: (worker: TestWorker) => Effect.Effect<void>) {
            const worker = yield* startTestWorker({
              name: "images-persist-test",
              compatibilityDate: "2025-04-01",
              compatibilityFlags: [],
              modules: [
                { name: "main.js", type: "ESModule", content: TEST_SCRIPT },
              ],
              bindings: [Images.local({ binding: "IMAGES" })],
            });
            yield* run(worker);
          },
          (self) =>
            self.pipe(Effect.provide(runtimeLayerTempDir), Effect.scoped),
        );

        yield* runAgainstStorage((worker) =>
          Effect.gen(function* () {
            yield* upload(worker, TEST_IMAGE_BYTES, { id: "persist-test" });
            const data = yield* sendCmd<Array<number>>(worker, "bytes", {
              id: "persist-test",
            });
            expect(new Uint8Array(data)).toEqual(TEST_IMAGE_BYTES);
          }),
        );

        // Directories created for the Durable Object SQLite database and the
        // store's blobs, mirroring the KV persistence layout under a distinct
        // `images` root.
        const names = yield* fs.readDirectory(path.join(tmp, "images"));
        expect(names).toContain("cloudflare-runtime-images-KVNamespaceObject");
        expect(names).toContain(Images.IMAGES_STORE_NAMESPACE);

        // "Restarting" keeps persisted data.
        yield* runAgainstStorage((worker) =>
          Effect.gen(function* () {
            const data = yield* sendCmd<Array<number>>(worker, "bytes", {
              id: "persist-test",
            });
            expect(new Uint8Array(data)).toEqual(TEST_IMAGE_BYTES);
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 30_000 },
  );
});
