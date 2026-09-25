// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Adapted from Miniflare's stream plugin tests
 * (`workers-sdk/packages/miniflare/test/plugins/stream/index.spec.ts`).
 *
 * Miniflare drives the binding through `dispatchFetch` against a fresh
 * in-memory Miniflare instance per test; here a test worker exposes the
 * binding over HTTP (`POST /` with a `{ op, args }` JSON command — the same
 * command dispatcher as the upstream `WORKER_SCRIPT`). Tests that only touch
 * videos/captions/downloads they created share one worker; tests that assert
 * global state (video/watermark listings, fake-timer ordering) each start an
 * isolated runtime, mirroring upstream's fresh-instance-per-test semantics.
 * Control operations (fake timers, storage inspection) reach the
 * `StreamObject` Durable Object through a raw service binding to the `stream`
 * service's default entrypoint, replacing upstream's
 * `_getInternalDurableObjectNamespace` control stub.
 *
 * Upstream tests intentionally not ported:
 * - "keeps in-memory data across setOptions reloads" and "keeps persisted
 *   data when persistence path format changes on reload": rely on
 *   Miniflare's `setOptions`; restart persistence is covered by
 *   "persists on file-system".
 * - "preview URLs use publicUrl when set" and "preview URLs update when
 *   publicUrl is changed via setter": this runtime has no `publicUrl`
 *   override — the loopback route always serves the runtime entry URL, which
 *   is what "preview URLs use runtime entry URL when publicUrl is not set"
 *   pins.
 * Fixture video/image bytes are the upstream constants (8 and 4 bytes),
 * served from a per-test Node HTTP server like upstream's `useServer`.
 */
import assert from "node:assert";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Stream from "../../bindings/stream/index.ts";
import * as Docker from "../../Docker.ts";
import * as Globals from "../../globals/Globals.ts";
import * as Internet from "../../globals/Internet.ts";
import * as Storage from "../../globals/Storage.ts";
import * as Paths from "../../internal/Paths.ts";
import * as Plugin from "../../Plugin.ts";
import * as Runtime from "../../Runtime.ts";
import * as RuntimeServices from "../../RuntimeServices.ts";
import * as Workerd from "../../workerd/Workerd.ts";
import type { TestWorker } from "../helpers/runtime.ts";
import {
  localRuntimeLayer,
  makeTempDirectory,
  startTestWorker,
} from "../helpers/runtime.ts";

// Mock image / video bytes (upstream constants)
const TEST_VIDEO_BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
const TEST_IMAGE_BYTES = new Uint8Array([255, 216, 255, 224]);
const FAKE_TIME_START = 1_000_000;

// -----------------------------------------------------------------------------
// Result types (subset of the `StreamVideo`/... shapes the tests assert on)
// -----------------------------------------------------------------------------

interface Video {
  id: string;
  creator: string | null;
  meta: Record<string, string>;
  readyToStream: boolean;
  requireSignedURLs: boolean | null;
  thumbnailTimestampPct: number;
  scheduledDeletion: string | null;
  status: { state: string };
  size: number;
  created: string;
  modified: string;
  preview: string;
  hlsPlaybackUrl: string;
  dashPlaybackUrl: string;
}

interface Caption {
  language: string;
  label: string;
  generated: boolean;
  status: string | null;
}

interface Watermark {
  id: string;
  name: string;
  size: number;
  created: string;
  downloadedFrom: string | null;
  opacity: number;
  padding: number;
  scale: number;
  position: string;
}

interface Download {
  status: string;
  percentComplete: number;
  url?: string;
}

type DownloadGetResponse = { default?: Download; audio?: Download };

// -----------------------------------------------------------------------------
// Fixture servers (upstream `useServer` + listeners)
// -----------------------------------------------------------------------------

const useServer = (listener: NodeHttp.RequestListener) =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => NodeHttp.createServer(listener)),
      (server) =>
        Effect.sync(() => {
          server.closeAllConnections();
          server.close();
        }),
    );
    yield* Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    });
    const address = server.address() as NodeNet.AddressInfo;
    return new URL(`http://127.0.0.1:${address.port}`);
  });

const staticBytesListener =
  (bytes: Uint8Array): NodeHttp.RequestListener =>
  (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(Buffer.from(bytes));
  };

const statusListener =
  (statusCode: number, statusMessage?: string): NodeHttp.RequestListener =>
  (_req, res) => {
    res.writeHead(statusCode, statusMessage);
    res.end();
  };

// -----------------------------------------------------------------------------
// Test worker: the upstream `WORKER_SCRIPT` command dispatcher + /control
// -----------------------------------------------------------------------------

const TEST_SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/control") {
      return env.CONTROL.fetch("http://placeholder/", {
        method: "POST",
        headers: { "${Stream.HEADER_STREAM_CONTROL_OP}": "true" },
        body: request.body,
      });
    }
    try {
      const { op, args } = await request.json();
      const stream = env.STREAM;
      const result = await handleCommand(stream, op, args || {});
      return Response.json({ ok: true, result });
    } catch (err) {
      return Response.json({
        ok: false,
        error: err.message,
        name: err.name,
        code: err.code,
        statusCode: err.statusCode,
      }, { status: 200 });
    }
  }
}

async function handleCommand(stream, op, args) {
  switch (op) {
    case "upload": {
      const resp = await fetch(args.url);
      return stream.upload(resp.body, args.params);
    }
    case "upload.fromUrl":
      return stream.upload(args.url, args.params);
    case "video.details":
      return stream.video(args.id).details();
    case "video.update":
      return stream.video(args.id).update(args.params);
    case "video.delete":
      await stream.video(args.id).delete();
      return null;
    case "video.generateToken":
      return stream.video(args.id).generateToken();
    case "videos.list":
      return stream.videos.list(args.params);
    case "captions.generate":
      return stream.video(args.id).captions.generate(args.language);
    case "captions.list":
      return stream.video(args.id).captions.list(args.language);
    case "captions.delete":
      await stream.video(args.id).captions.delete(args.language);
      return null;
    case "captions.upload": {
      const stream_input = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("test"));
          controller.close();
        }
      });
      return stream.video(args.id).captions.upload(args.language, stream_input);
    }
    case "downloads.generate":
      return stream.video(args.id).downloads.generate(args.type);
    case "downloads.get":
      return stream.video(args.id).downloads.get();
    case "downloads.delete":
      await stream.video(args.id).downloads.delete(args.type);
      return null;
    case "watermarks.generate": {
      const resp = await fetch(args.url);
      return stream.watermarks.generate(resp.body, args.params || {});
    }
    case "watermarks.generate.fromUrl":
      return stream.watermarks.generate(args.url, args.params || {});
    case "watermarks.generate.fromStream": {
      const stream_input = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("test"));
          controller.close();
        }
      });
      return stream.watermarks.generate(stream_input, args.params || {});
    }
    case "watermarks.list":
      return stream.watermarks.list();
    case "watermarks.get":
      return stream.watermarks.get(args.id);
    case "watermarks.delete":
      await stream.watermarks.delete(args.id);
      return null;
    case "createDirectUpload":
      return stream.createDirectUpload(args.params || {});
    default:
      throw new Error("Unknown op: " + op);
  }
}
`;

const compatibilityDate = "2026-03-23";
const modules = [
  { name: "main.js", type: "ESModule", content: TEST_SCRIPT },
] as const;

// Raw binding to the `stream` service's default entrypoint, used to send
// control operations (fake timers, storage inspection) to the `StreamObject`
// Durable Object. The plugin doesn't export a hook for this; the designator
// is constructed directly, relying on the `STREAM` binding to make the
// services exist.
const controlBinding = Effect.succeed({
  name: "CONTROL",
  service: { name: Stream.SERVICE_STREAM },
});

const makeStreamWorker = (name: string) =>
  startTestWorker({
    name,
    compatibilityDate,
    compatibilityFlags: [],
    modules: [...modules],
    bindings: [Stream.local({ binding: "STREAM" }), controlBinding],
  });

const sendCmd = <T>(
  worker: TestWorker,
  op: string,
  args: Record<string, unknown> = {},
) =>
  Effect.gen(function* () {
    const body = yield* worker.fetchJson<
      | { ok: true; result: T }
      | {
          ok: false;
          error: string;
          name?: string;
          code?: number;
          statusCode?: number;
        }
    >("/", { method: "POST", body: JSON.stringify({ op, args }) });
    if (!body.ok) {
      return yield* Effect.fail(new Error(body.error));
    }
    return body.result;
  });

/**
 * Runs `sendCmd` and returns the failure message (fails if it succeeded).
 *
 * Note: errors thrown across the JS RPC boundary arrive in the user worker as
 * tunneled exceptions whose message is prefixed with the original constructor
 * name (`"BadRequestError: opacity must be..."`) — exactly what upstream's
 * workers see too. Upstream asserts messages with `.rejects.toThrow(...)`,
 * which is substring matching, so message assertions here use `toContain`.
 */
const sendCmdError = (
  worker: TestWorker,
  op: string,
  args: Record<string, unknown> = {},
) =>
  sendCmd(worker, op, args).pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  );

/**
 * Sends control operations to the `StreamObject` Durable Object through the
 * test worker's `/control` route (equivalent of Miniflare's
 * `MiniflareDurableObjectControlStub`).
 */
class ControlStub {
  constructor(readonly baseUrl: URL) {}

  async #op(name: string, ...args: Array<unknown>): Promise<Response> {
    const res = await fetch(new URL("/control", this.baseUrl), {
      method: "POST",
      body: JSON.stringify({ name, args }),
    });
    assert(
      res.status === 200 || res.status === 404,
      `Control op ${name} failed: ${res.status}`,
    );
    return res;
  }

  async enableFakeTimers(timestamp: number): Promise<void> {
    await this.#op("enableFakeTimers", timestamp);
  }

  async advanceFakeTime(delta: number): Promise<void> {
    await this.#op("advanceFakeTime", delta);
  }

  async waitForFakeTasks(): Promise<void> {
    await this.#op("waitForFakeTasks");
  }

  async sqlQuery<Row>(
    query: string,
    ...params: Array<unknown>
  ): Promise<Array<Row>> {
    const res = await this.#op("sqlQuery", query, ...params);
    return (await res.json()) as Array<Row>;
  }

  async getBlob(id: string): Promise<Uint8Array | null> {
    const res = await this.#op("getBlob", id);
    if (res.status === 404) return null;
    return new Uint8Array(await res.arrayBuffer());
  }
}

const uploadVideo = (
  worker: TestWorker,
  videoUrl: URL,
  params?: Record<string, unknown>,
) =>
  sendCmd<Video>(worker, "upload", {
    url: videoUrl.toString(),
    ...(params ? { params } : {}),
  });

// -----------------------------------------------------------------------------
// Shared test worker (id-scoped tests)
// -----------------------------------------------------------------------------

class StreamTestWorker extends Context.Service<StreamTestWorker, TestWorker>()(
  "test/StreamTestWorker",
) {}

const StreamTestWorkerLive = Layer.effect(
  StreamTestWorker,
  makeStreamWorker("stream-test"),
);

const StreamTestLayer = StreamTestWorkerLive.pipe(
  Layer.provideMerge(localRuntimeLayer),
  // Let control ops (fake timers, storage inspection) through to the
  // `StreamObject` Durable Object
  Layer.provide(Layer.succeed(Plugin.UnsafeEnableControlEndpoints, true)),
);

// A fresh runtime per test, for tests that assert global state (listings,
// fake-timer ordering) — the equivalent of upstream's fresh Miniflare
// instance per test.
const IsolatedStreamLayer = localRuntimeLayer.pipe(
  Layer.provide(Layer.succeed(Plugin.UnsafeEnableControlEndpoints, true)),
);

const isolated = <A, E>(
  run: (worker: TestWorker) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const worker = yield* makeStreamWorker("stream-isolated-test");
    return yield* run(worker);
  }).pipe(Effect.scoped, Effect.provide(IsolatedStreamLayer));

// -----------------------------------------------------------------------------
// Shared-worker tests
// -----------------------------------------------------------------------------

layer(StreamTestLayer)("Stream binding", (it) => {
  describe("Stream videos", () => {
    it.effect("upload and retrieve details", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);

        expect(video.id).toBeTruthy();
        expect(video.readyToStream).toBe(true);
        expect(video.status.state).toBe("ready");
        expect(video.size).toBe(TEST_VIDEO_BYTES.byteLength);
        expect(video.created).toBeTruthy();
        expect(video.modified).toBeTruthy();
        expect(video.hlsPlaybackUrl).toContain(video.id);
        expect(video.dashPlaybackUrl).toContain(video.id);
        expect(video.preview).toMatch(
          new RegExp(`^http://.*?/cdn-cgi/mf/stream/${video.id}/watch$`),
        );

        const details = yield* sendCmd<Video>(worker, "video.details", {
          id: video.id,
        });
        expect(details.id).toBe(video.id);
        expect(details.readyToStream).toBe(true);
      }).pipe(Effect.scoped),
    );

    it.effect("upload with params", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl, {
          creator: "test-creator",
          meta: { title: "Test Video" },
          requireSignedURLs: true,
          thumbnailTimestampPct: 0.5,
        });

        expect(video.creator).toBe("test-creator");
        expect(video.meta).toEqual({ title: "Test Video" });
        expect(video.requireSignedURLs).toBe(true);
        expect(video.thumbnailTimestampPct).toBe(0.5);
      }).pipe(Effect.scoped),
    );

    it.effect("upload from URL propagates fetch failures", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(statusListener(500, "Boom"));

        const message = yield* sendCmdError(worker, "upload.fromUrl", {
          url: videoUrl.toString(),
        });
        expect(message).toContain("Failed to fetch video from URL: 500 Boom");
      }).pipe(Effect.scoped),
    );

    it.effect("throw when getting details for non existent video", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const message = yield* sendCmdError(worker, "video.details", {
          id: "00000000-0000-0000-0000-000000000000",
        });
        expect(message).toContain("Video not found");
      }),
    );

    it.effect("update video metadata", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);
        const originalModified = video.modified;

        const updated = yield* sendCmd<Video>(worker, "video.update", {
          id: video.id,
          params: {
            creator: "new-creator",
            meta: { description: "Updated" },
          },
        });

        expect(updated.id).toBe(video.id);
        expect(updated.creator).toBe("new-creator");
        expect(updated.meta).toEqual({ description: "Updated" });
        expect(updated.modified).not.toBe(originalModified);
      }).pipe(Effect.scoped),
    );

    it.effect("throws when updating non existent video", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const message = yield* sendCmdError(worker, "video.update", {
          id: "00000000-0000-0000-0000-000000000000",
          params: { creator: "nobody" },
        });
        expect(message).toContain("Video not found");
      }),
    );

    it.effect("delete video", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);
        yield* sendCmd(worker, "video.delete", { id: video.id });

        const message = yield* sendCmdError(worker, "video.details", {
          id: video.id,
        });
        expect(message).toContain("Video not found");
      }).pipe(Effect.scoped),
    );

    it.effect("throws when deleting non existent video", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const message = yield* sendCmdError(worker, "video.delete", {
          id: "00000000-0000-0000-0000-000000000000",
        });
        expect(message).toContain("Video not found");
      }),
    );

    it.effect("partial update preserves untouched fields", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl, {
          creator: "original-creator",
          meta: { title: "Original" },
          requireSignedURLs: true,
          thumbnailTimestampPct: 0.3,
        });

        // Only update creator — all other fields should be preserved
        const updated = yield* sendCmd<Video>(worker, "video.update", {
          id: video.id,
          params: { creator: "new-creator" },
        });

        expect(updated.creator).toBe("new-creator");
        expect(updated.meta).toEqual({ title: "Original" });
        expect(updated.requireSignedURLs).toBe(true);
        expect(updated.thumbnailTimestampPct).toBe(0.3);
      }).pipe(Effect.scoped),
    );

    it.effect("update can null-clear creator and scheduledDeletion", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl, {
          creator: "will-be-cleared",
          scheduledDeletion: new Date(Date.now() + 86_400_000).toISOString(),
        });

        expect(video.creator).toBe("will-be-cleared");
        expect(video.scheduledDeletion).toBeTruthy();

        const updated = yield* sendCmd<Video>(worker, "video.update", {
          id: video.id,
          params: { creator: null, scheduledDeletion: null },
        });

        expect(updated.creator).toBeNull();
        expect(updated.scheduledDeletion).toBeNull();
      }).pipe(Effect.scoped),
    );

    it.effect("generate token", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);
        const token = yield* sendCmd<string>(worker, "video.generateToken", {
          id: video.id,
        });

        expect(typeof token).toBe("string");
        // Token is b64 encoded JSON
        const payload = JSON.parse(atob(token)) as {
          sub: string;
          kid: string;
          exp: number;
        };
        expect(payload.sub).toBe(video.id);
        expect(payload.kid).toBe("local-mode-key");
        expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
      }).pipe(Effect.scoped),
    );

    it.effect("generate token for non-existent video throws", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const message = yield* sendCmdError(worker, "video.generateToken", {
          id: "00000000-0000-0000-0000-000000000000",
        });
        expect(message).toContain("Video not found");
      }),
    );
  });

  describe("Stream video serving", () => {
    it.effect("serve video via /cdn-cgi/mf/stream/:id/watch", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);

        const resp = yield* worker.fetch(
          `/cdn-cgi/mf/stream/${video.id}/watch`,
        );
        const bytes = new Uint8Array(
          yield* Effect.promise(() => resp.arrayBuffer()),
        );
        expect(resp.status).toBe(200);
        expect(bytes).toEqual(TEST_VIDEO_BYTES);
      }).pipe(Effect.scoped),
    );

    it.effect("serve video returns 404 for unknown video", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const resp = yield* worker.fetch(
          "/cdn-cgi/mf/stream/00000000-0000-0000-0000-000000000000/watch",
        );
        yield* Effect.promise(() => resp.arrayBuffer());
        expect(resp.status).toBe(404);
      }),
    );

    it.effect("preview URL from upload is directly fetchable over HTTP", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);

        expect(video.preview).toBeDefined();
        const resp = yield* Effect.promise(() => fetch(video.preview));
        expect(resp.status).toBe(200);
        const bytes = new Uint8Array(
          yield* Effect.promise(() => resp.arrayBuffer()),
        );
        expect(bytes).toEqual(TEST_VIDEO_BYTES);
      }).pipe(Effect.scoped),
    );

    it.effect("preview URLs use runtime entry URL", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);

        // The preview URL uses the runtime entry URL (http://127.0.0.1:<port>)
        expect(video.preview).toMatch(
          new RegExp(
            `^http://127\\.0\\.0\\.1:\\d+/cdn-cgi/mf/stream/${video.id}/watch$`,
          ),
        );
        expect(video.preview).toBe(
          `${worker.baseUrl.origin}/cdn-cgi/mf/stream/${video.id}/watch`,
        );
      }).pipe(Effect.scoped),
    );
  });

  describe("Stream captions", () => {
    it.effect("generate caption", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);
        const caption = yield* sendCmd<Caption>(worker, "captions.generate", {
          id: video.id,
          language: "en",
        });

        expect(caption.language).toBe("en");
        expect(caption.generated).toBe(true);
        expect(caption.status).toBe("ready");
        expect(caption.label).toBeTruthy();
      }).pipe(Effect.scoped),
    );

    it.effect("list captions", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);
        yield* sendCmd(worker, "captions.generate", {
          id: video.id,
          language: "en",
        });
        yield* sendCmd(worker, "captions.generate", {
          id: video.id,
          language: "fr",
        });

        const captions = yield* sendCmd<Array<Caption>>(
          worker,
          "captions.list",
          { id: video.id },
        );
        expect(captions).toHaveLength(2);
        const languages = captions.map((caption) => caption.language);
        expect(languages).toContain("en");
        expect(languages).toContain("fr");
      }).pipe(Effect.scoped),
    );

    it.effect("list captions filtered by language", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);
        yield* sendCmd(worker, "captions.generate", {
          id: video.id,
          language: "en",
        });
        yield* sendCmd(worker, "captions.generate", {
          id: video.id,
          language: "fr",
        });

        const enOnly = yield* sendCmd<Array<Caption>>(worker, "captions.list", {
          id: video.id,
          language: "en",
        });
        expect(enOnly).toHaveLength(1);
        expect(enOnly[0].language).toBe("en");
      }).pipe(Effect.scoped),
    );

    it.effect("list captions empty language filter", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);
        yield* sendCmd(worker, "captions.generate", {
          id: video.id,
          language: "en",
        });

        const deOnly = yield* sendCmd<Array<Caption>>(worker, "captions.list", {
          id: video.id,
          language: "de",
        });
        expect(deOnly).toHaveLength(0);
      }).pipe(Effect.scoped),
    );

    it.effect("delete caption", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);
        yield* sendCmd(worker, "captions.generate", {
          id: video.id,
          language: "en",
        });
        yield* sendCmd(worker, "captions.delete", {
          id: video.id,
          language: "en",
        });

        const remaining = yield* sendCmd<Array<Caption>>(
          worker,
          "captions.list",
          { id: video.id },
        );
        expect(remaining).toHaveLength(0);
      }).pipe(Effect.scoped),
    );

    it.effect("throws when deleting non existent caption", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);

        const message = yield* sendCmdError(worker, "captions.delete", {
          id: video.id,
          language: "zh",
        });
        expect(message).toContain("Caption not found");
      }).pipe(Effect.scoped),
    );

    it.effect("throws when getting caption for non existent video", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const message = yield* sendCmdError(worker, "captions.generate", {
          id: "00000000-0000-0000-0000-000000000000",
          language: "en",
        });
        expect(message).toContain("Video not found");
      }),
    );

    it.effect("caption upload via ReadableStream", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);

        const caption = yield* sendCmd<Caption>(worker, "captions.upload", {
          id: video.id,
          language: "en",
        });

        expect(caption.language).toBe("en");
        expect(caption.generated).toBe(false);
        expect(caption.status).toBe("ready");
      }).pipe(Effect.scoped),
    );

    it.effect("caption upload throws for non-existent video", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const message = yield* sendCmdError(worker, "captions.upload", {
          id: "00000000-0000-0000-0000-000000000000",
          language: "en",
        });
        expect(message).toContain("Video not found");
      }),
    );

    it.effect("upload caption is idempotent (upsert)", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);

        // Upload the same caption twice
        yield* sendCmd(worker, "captions.upload", {
          id: video.id,
          language: "en",
        });
        yield* sendCmd(worker, "captions.upload", {
          id: video.id,
          language: "en",
        });

        // Should still only have one caption, not two
        const captions = yield* sendCmd<Array<Caption>>(
          worker,
          "captions.list",
          { id: video.id },
        );
        expect(
          captions.filter((caption) => caption.language === "en"),
        ).toHaveLength(1);
      }).pipe(Effect.scoped),
    );

    it.effect("generate caption is idempotent (upsert)", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);

        // Generate the same caption twice
        yield* sendCmd(worker, "captions.generate", {
          id: video.id,
          language: "en",
        });
        yield* sendCmd(worker, "captions.generate", {
          id: video.id,
          language: "en",
        });

        // Should still only have one caption, not two
        const captions = yield* sendCmd<Array<Caption>>(
          worker,
          "captions.list",
          { id: video.id },
        );
        expect(
          captions.filter((caption) => caption.language === "en"),
        ).toHaveLength(1);
      }).pipe(Effect.scoped),
    );

    it.effect("list captions throws for non-existent video", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const message = yield* sendCmdError(worker, "captions.list", {
          id: "00000000-0000-0000-0000-000000000000",
        });
        expect(message).toContain("Video not found");
      }),
    );

    it.effect("delete caption throws for non-existent video", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const message = yield* sendCmdError(worker, "captions.delete", {
          id: "00000000-0000-0000-0000-000000000000",
          language: "en",
        });
        expect(message).toContain("Caption not found");
      }),
    );
  });

  describe("Stream watermarks", () => {
    it.effect("create watermark from URL", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const imageUrl = yield* useServer(
          staticBytesListener(TEST_IMAGE_BYTES),
        );

        const watermark = yield* sendCmd<Watermark>(
          worker,
          "watermarks.generate",
          {
            url: imageUrl.toString(),
            params: { name: "test-watermark" },
          },
        );

        expect(watermark.id).toBeTruthy();
        expect(watermark.name).toBe("test-watermark");
        expect(watermark.size).toBe(TEST_IMAGE_BYTES.byteLength);
        expect(watermark.created).toBeTruthy();

        expect(watermark.opacity).toBe(1.0);
        expect(watermark.padding).toBe(0.05);
        expect(watermark.scale).toBe(0.15);
        expect(watermark.position).toBe("upperRight");
      }).pipe(Effect.scoped),
    );

    it.effect("create watermark with custom params", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const imageUrl = yield* useServer(
          staticBytesListener(TEST_IMAGE_BYTES),
        );

        const watermark = yield* sendCmd<Watermark>(
          worker,
          "watermarks.generate",
          {
            url: imageUrl.toString(),
            params: {
              name: "custom",
              opacity: 0.5,
              padding: 0.1,
              scale: 0.3,
              position: "center",
            },
          },
        );

        expect(watermark.opacity).toBe(0.5);
        expect(watermark.padding).toBe(0.1);
        expect(watermark.scale).toBe(0.3);
        expect(watermark.position).toBe("center");
      }).pipe(Effect.scoped),
    );

    it.effect("create watermark from URL propagates fetch failures", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const imageUrl = yield* useServer(statusListener(404, "Missing"));

        const message = yield* sendCmdError(
          worker,
          "watermarks.generate.fromUrl",
          {
            url: imageUrl.toString(),
            params: { name: "missing" },
          },
        );
        expect(message).toContain(
          "Failed to fetch watermark from URL: 404 Missing",
        );
      }).pipe(Effect.scoped),
    );

    it.effect("create watermark from ReadableStream", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const watermark = yield* sendCmd<Watermark>(
          worker,
          "watermarks.generate.fromStream",
          {
            params: { name: "from-stream" },
          },
        );
        expect(watermark.name).toBe("from-stream");
      }),
    );

    it.effect("get watermark", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const imageUrl = yield* useServer(
          staticBytesListener(TEST_IMAGE_BYTES),
        );

        const created = yield* sendCmd<Watermark>(
          worker,
          "watermarks.generate",
          {
            url: imageUrl.toString(),
            params: { name: "get-test" },
          },
        );
        const fetched = yield* sendCmd<Watermark>(worker, "watermarks.get", {
          id: created.id,
        });

        expect(fetched.id).toBe(created.id);
        expect(fetched.name).toBe("get-test");
      }).pipe(Effect.scoped),
    );

    it.effect("get non-existent watermark throws", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const message = yield* sendCmdError(worker, "watermarks.get", {
          id: "00000000-0000-0000-0000-000000000000",
        });
        expect(message).toContain("Watermark not found");
      }),
    );

    it.effect("throws when deleting non existent watermark", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const message = yield* sendCmdError(worker, "watermarks.delete", {
          id: "00000000-0000-0000-0000-000000000000",
        });
        expect(message).toContain("Watermark not found");
      }),
    );

    it.effect("opacity out of range throws", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const imageUrl = yield* useServer(
          staticBytesListener(TEST_IMAGE_BYTES),
        );

        const message = yield* sendCmdError(worker, "watermarks.generate", {
          url: imageUrl.toString(),
          params: { opacity: 2.0 },
        });
        expect(message).toContain("opacity must be between 0.0 and 1.0");
      }).pipe(Effect.scoped),
    );

    it.effect("padding out of range throws", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const imageUrl = yield* useServer(
          staticBytesListener(TEST_IMAGE_BYTES),
        );

        const message = yield* sendCmdError(worker, "watermarks.generate", {
          url: imageUrl.toString(),
          params: { padding: -0.1 },
        });
        expect(message).toContain("padding must be between 0.0 and 1.0");
      }).pipe(Effect.scoped),
    );

    it.effect("scale out of range throws", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const imageUrl = yield* useServer(
          staticBytesListener(TEST_IMAGE_BYTES),
        );

        const message = yield* sendCmdError(worker, "watermarks.generate", {
          url: imageUrl.toString(),
          params: { scale: 1.1 },
        });
        expect(message).toContain("scale must be between 0.0 and 1.0");
      }).pipe(Effect.scoped),
    );

    it.effect("boundary values 0.0 and 1.0 are accepted for range params", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const imageUrl = yield* useServer(
          staticBytesListener(TEST_IMAGE_BYTES),
        );

        // 0.0 and 1.0 are valid boundary values — should not throw
        const watermark = yield* sendCmd<Watermark>(
          worker,
          "watermarks.generate",
          {
            url: imageUrl.toString(),
            params: { opacity: 0.0, padding: 1.0, scale: 0.0 },
          },
        );

        expect(watermark.id).toBeTruthy();
        expect(watermark.opacity).toBe(0.0);
        expect(watermark.padding).toBe(1.0);
        expect(watermark.scale).toBe(0.0);
      }).pipe(Effect.scoped),
    );

    it.effect("watermark created with empty name stores empty string", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const imageUrl = yield* useServer(
          staticBytesListener(TEST_IMAGE_BYTES),
        );

        const watermark = yield* sendCmd<Watermark>(
          worker,
          "watermarks.generate",
          {
            url: imageUrl.toString(),
            params: {},
          },
        );

        expect(watermark.name).toBe("");
      }).pipe(Effect.scoped),
    );

    it.effect("create watermark from ReadableStream stores correct size", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const imageUrl = yield* useServer(
          staticBytesListener(TEST_IMAGE_BYTES),
        );

        // The "watermarks.generate" op fetches the URL and passes resp.body
        // (a ReadableStream)
        const watermark = yield* sendCmd<Watermark>(
          worker,
          "watermarks.generate",
          {
            url: imageUrl.toString(),
            params: { name: "stream-wm" },
          },
        );

        expect(watermark.size).toBe(TEST_IMAGE_BYTES.byteLength);
        // downloadedFrom is null when created from a stream (not a URL)
        expect(watermark.downloadedFrom).toBeNull();
      }).pipe(Effect.scoped),
    );
  });

  describe("Stream downloads", () => {
    it.effect("generate default download", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);
        const result = yield* sendCmd<DownloadGetResponse>(
          worker,
          "downloads.generate",
          {
            id: video.id,
          },
        );

        expect(result.default).toBeDefined();
        expect(result.default?.status).toBe("ready");
        expect(result.default?.percentComplete).toBe(100);
      }).pipe(Effect.scoped),
    );

    it.effect("generate audio download", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);
        const result = yield* sendCmd<DownloadGetResponse>(
          worker,
          "downloads.generate",
          {
            id: video.id,
            type: "audio",
          },
        );

        expect(result.audio).toBeDefined();
        expect(result.audio?.status).toBe("ready");
      }).pipe(Effect.scoped),
    );

    it.effect("get downloads", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);
        yield* sendCmd(worker, "downloads.generate", {
          id: video.id,
          type: "default",
        });
        yield* sendCmd(worker, "downloads.generate", {
          id: video.id,
          type: "audio",
        });

        const result = yield* sendCmd<DownloadGetResponse>(
          worker,
          "downloads.get",
          {
            id: video.id,
          },
        );
        expect(result.default).toBeDefined();
        expect(result.audio).toBeDefined();
      }).pipe(Effect.scoped),
    );

    it.effect("get downloads when none exist returns empty object", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);
        const result = yield* sendCmd<DownloadGetResponse>(
          worker,
          "downloads.get",
          {
            id: video.id,
          },
        );

        expect(result.default).toBeUndefined();
        expect(result.audio).toBeUndefined();
      }).pipe(Effect.scoped),
    );

    it.effect("delete download", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);
        yield* sendCmd(worker, "downloads.generate", {
          id: video.id,
          type: "default",
        });
        yield* sendCmd(worker, "downloads.delete", {
          id: video.id,
          type: "default",
        });

        const result = yield* sendCmd<DownloadGetResponse>(
          worker,
          "downloads.get",
          {
            id: video.id,
          },
        );
        expect(result.default).toBeUndefined();
      }).pipe(Effect.scoped),
    );

    it.effect("throws when deleting non existent download", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);

        const message = yield* sendCmdError(worker, "downloads.delete", {
          id: video.id,
          type: "default",
        });
        expect(message).toContain("Download not found");
      }).pipe(Effect.scoped),
    );

    it.effect("throws on download of non existent video", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const message = yield* sendCmdError(worker, "downloads.generate", {
          id: "00000000-0000-0000-0000-000000000000",
        });
        expect(message).toContain("Video not found");
      }),
    );

    it.effect("get downloads for non existent video throws", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const message = yield* sendCmdError(worker, "downloads.get", {
          id: "00000000-0000-0000-0000-000000000000",
        });
        expect(message).toContain("Video not found");
      }),
    );

    it.effect("generate download is idempotent (upsert)", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);

        // Generate the same download twice
        yield* sendCmd(worker, "downloads.generate", {
          id: video.id,
          type: "default",
        });
        yield* sendCmd(worker, "downloads.generate", {
          id: video.id,
          type: "default",
        });

        // Should still only have one default download entry
        const result = yield* sendCmd<DownloadGetResponse>(
          worker,
          "downloads.get",
          {
            id: video.id,
          },
        );
        expect(result.default).toBeDefined();
        expect(result.default?.status).toBe("ready");
        // audio should not be present
        expect(result.audio).toBeUndefined();
      }).pipe(Effect.scoped),
    );

    it.effect("delete download throws for non-existent video", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const message = yield* sendCmdError(worker, "downloads.delete", {
          id: "00000000-0000-0000-0000-000000000000",
          type: "default",
        });
        expect(message).toContain("Download not found");
      }),
    );
  });

  describe("Stream unsupported binding operations", () => {
    it.effect("createDirectUpload is not supported", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const message = yield* sendCmdError(worker, "createDirectUpload");
        expect(message).toContain(
          "createDirectUpload is not supported in local mode",
        );
      }),
    );
  });

  describe("Stream deletes clean up properly", () => {
    it.effect("deleting video cleans up captions and downloads", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);
        const id = video.id;

        // Create associated data
        yield* sendCmd(worker, "captions.generate", { id, language: "en" });
        yield* sendCmd(worker, "downloads.generate", { id, type: "default" });

        // Delete the video
        yield* sendCmd(worker, "video.delete", { id });

        // Video is gone
        expect(yield* sendCmdError(worker, "video.details", { id })).toContain(
          "Video not found",
        );

        // Captions are gone (via FK cascade)
        expect(yield* sendCmdError(worker, "captions.list", { id })).toContain(
          "Video not found",
        );

        // Downloads are gone (via explicit delete + cascade)
        expect(yield* sendCmdError(worker, "downloads.get", { id })).toContain(
          "Video not found",
        );
      }).pipe(Effect.scoped),
    );

    it.effect("deleting video cleans up its blob from storage", () =>
      Effect.gen(function* () {
        const worker = yield* StreamTestWorker;
        const videoUrl = yield* useServer(
          staticBytesListener(TEST_VIDEO_BYTES),
        );

        const video = yield* uploadVideo(worker, videoUrl);
        // Grab the blob id before deleting so its removal can be asserted
        // out-of-band through the control endpoints.
        const object = new ControlStub(worker.baseUrl);
        const rows = yield* Effect.promise(() =>
          object.sqlQuery<{ blob_id: string | null }>(
            "SELECT blob_id FROM _mf_stream_videos WHERE id = ?",
            video.id,
          ),
        );
        const blobId = rows[0]?.blob_id;
        expect(blobId).toBeTruthy();
        assert(blobId);

        yield* sendCmd(worker, "video.delete", { id: video.id });
        expect(yield* Effect.promise(() => object.getBlob(blobId))).toBeNull();

        // Upload a new video to ensure storage is still functional
        const video2 = yield* uploadVideo(worker, videoUrl);
        expect(video2.id).not.toBe(video.id);
        const details = yield* sendCmd<Video>(worker, "video.details", {
          id: video2.id,
        });
        expect(details.size).toBe(TEST_VIDEO_BYTES.byteLength);
      }).pipe(Effect.scoped),
    );

    it.effect(
      "deleting one video does not affect another video's captions and downloads",
      () =>
        Effect.gen(function* () {
          const worker = yield* StreamTestWorker;
          const videoUrl = yield* useServer(
            staticBytesListener(TEST_VIDEO_BYTES),
          );

          const videoA = yield* uploadVideo(worker, videoUrl);
          const videoB = yield* uploadVideo(worker, videoUrl);

          // Add captions and downloads to both
          yield* sendCmd(worker, "captions.generate", {
            id: videoA.id,
            language: "en",
          });
          yield* sendCmd(worker, "captions.generate", {
            id: videoB.id,
            language: "en",
          });
          yield* sendCmd(worker, "downloads.generate", {
            id: videoA.id,
            type: "default",
          });
          yield* sendCmd(worker, "downloads.generate", {
            id: videoB.id,
            type: "default",
          });

          // Delete only video A
          yield* sendCmd(worker, "video.delete", { id: videoA.id });

          // videoB's captions and downloads should be unaffected
          const captionsB = yield* sendCmd<Array<Caption>>(
            worker,
            "captions.list",
            {
              id: videoB.id,
            },
          );
          expect(captionsB).toHaveLength(1);
          expect(captionsB[0].language).toBe("en");

          const downloadsB = yield* sendCmd<DownloadGetResponse>(
            worker,
            "downloads.get",
            {
              id: videoB.id,
            },
          );
          expect(downloadsB.default).toBeDefined();
        }).pipe(Effect.scoped),
    );
  });
});

// -----------------------------------------------------------------------------
// Isolated-runtime tests (global listings and fake-timer ordering)
// -----------------------------------------------------------------------------

describe("Stream videos list", () => {
  it.effect(
    "list empty",
    () =>
      isolated((worker) =>
        Effect.gen(function* () {
          const videos = yield* sendCmd<Array<Video>>(worker, "videos.list");
          expect(videos).toEqual([]);
        }),
      ),
    { timeout: 30_000 },
  );

  it.effect(
    "list all videos",
    () =>
      isolated((worker) =>
        Effect.gen(function* () {
          const videoUrl = yield* useServer(
            staticBytesListener(TEST_VIDEO_BYTES),
          );

          yield* uploadVideo(worker, videoUrl);
          yield* uploadVideo(worker, videoUrl);
          yield* uploadVideo(worker, videoUrl);

          const videos = yield* sendCmd<Array<Video>>(worker, "videos.list");
          expect(videos).toHaveLength(3);
          for (const video of videos) {
            expect(video.id).toBeTruthy();
          }
        }),
      ),
    { timeout: 30_000 },
  );

  it.effect(
    "list with limit",
    () =>
      isolated((worker) =>
        Effect.gen(function* () {
          const videoUrl = yield* useServer(
            staticBytesListener(TEST_VIDEO_BYTES),
          );

          for (let i = 0; i < 5; i++) {
            yield* uploadVideo(worker, videoUrl);
          }

          const limited = yield* sendCmd<Array<Video>>(worker, "videos.list", {
            params: { limit: 2 },
          });
          expect(limited).toHaveLength(2);
        }),
      ),
    { timeout: 30_000 },
  );

  it.effect(
    "list rejects invalid before comparison operator",
    () =>
      isolated((worker) =>
        Effect.gen(function* () {
          const message = yield* sendCmdError(worker, "videos.list", {
            params: { before: new Date().toISOString(), beforeComp: "wat" },
          });
          expect(message).toContain("Invalid comparison operator: wat");
        }),
      ),
    { timeout: 30_000 },
  );

  it.effect(
    "list rejects invalid after comparison operator",
    () =>
      isolated((worker) =>
        Effect.gen(function* () {
          const message = yield* sendCmdError(worker, "videos.list", {
            params: { after: new Date().toISOString(), afterComp: "wat" },
          });
          expect(message).toContain("Invalid comparison operator: wat");
        }),
      ),
    { timeout: 30_000 },
  );

  it.effect(
    "list ordered by created descending",
    () =>
      isolated((worker) =>
        Effect.gen(function* () {
          const videoUrl = yield* useServer(
            staticBytesListener(TEST_VIDEO_BYTES),
          );
          const object = new ControlStub(worker.baseUrl);
          yield* Effect.promise(() => object.enableFakeTimers(FAKE_TIME_START));

          const v1 = yield* uploadVideo(worker, videoUrl);
          yield* Effect.promise(() => object.advanceFakeTime(5));
          const v2 = yield* uploadVideo(worker, videoUrl);
          yield* Effect.promise(() => object.advanceFakeTime(5));
          const v3 = yield* uploadVideo(worker, videoUrl);

          const videos = yield* sendCmd<Array<Video>>(worker, "videos.list");
          // Newest first
          expect(videos[0].id).toBe(v3.id);
          expect(videos[1].id).toBe(v2.id);
          expect(videos[2].id).toBe(v1.id);
        }),
      ),
    { timeout: 30_000 },
  );

  it.effect(
    "list filters by before date (default lt operator)",
    () =>
      isolated((worker) =>
        Effect.gen(function* () {
          const videoUrl = yield* useServer(
            staticBytesListener(TEST_VIDEO_BYTES),
          );
          const object = new ControlStub(worker.baseUrl);
          yield* Effect.promise(() => object.enableFakeTimers(FAKE_TIME_START));

          const v1 = yield* uploadVideo(worker, videoUrl);
          yield* Effect.promise(() => object.advanceFakeTime(10_000));
          yield* uploadVideo(worker, videoUrl);

          // Filter to only videos created before a cutoff that excludes v2
          const cutoff = new Date(FAKE_TIME_START + 5_000).toISOString();
          const filtered = yield* sendCmd<Array<Video>>(worker, "videos.list", {
            params: { before: cutoff },
          });

          expect(filtered).toHaveLength(1);
          expect(filtered[0].id).toBe(v1.id);
        }),
      ),
    { timeout: 30_000 },
  );

  it.effect(
    "list filters by after date (default gte operator)",
    () =>
      isolated((worker) =>
        Effect.gen(function* () {
          const videoUrl = yield* useServer(
            staticBytesListener(TEST_VIDEO_BYTES),
          );
          const object = new ControlStub(worker.baseUrl);
          yield* Effect.promise(() => object.enableFakeTimers(FAKE_TIME_START));

          yield* uploadVideo(worker, videoUrl);
          yield* Effect.promise(() => object.advanceFakeTime(10_000));
          const v2 = yield* uploadVideo(worker, videoUrl);

          // Filter to only videos created at or after a cutoff that excludes v1
          const cutoff = new Date(FAKE_TIME_START + 5_000).toISOString();
          const filtered = yield* sendCmd<Array<Video>>(worker, "videos.list", {
            params: { after: cutoff },
          });

          expect(filtered).toHaveLength(1);
          expect(filtered[0].id).toBe(v2.id);
        }),
      ),
    { timeout: 30_000 },
  );

  it.effect(
    "list filters with combined before and after bounds",
    () =>
      isolated((worker) =>
        Effect.gen(function* () {
          const videoUrl = yield* useServer(
            staticBytesListener(TEST_VIDEO_BYTES),
          );
          const object = new ControlStub(worker.baseUrl);
          yield* Effect.promise(() => object.enableFakeTimers(FAKE_TIME_START));

          yield* uploadVideo(worker, videoUrl); // t=0
          yield* Effect.promise(() => object.advanceFakeTime(10_000));
          const v2 = yield* uploadVideo(worker, videoUrl); // t=10s
          yield* Effect.promise(() => object.advanceFakeTime(10_000));
          yield* uploadVideo(worker, videoUrl); // t=20s

          const after = new Date(FAKE_TIME_START + 5_000).toISOString();
          const before = new Date(FAKE_TIME_START + 15_000).toISOString();
          const filtered = yield* sendCmd<Array<Video>>(worker, "videos.list", {
            params: { after, before },
          });

          expect(filtered).toHaveLength(1);
          expect(filtered[0].id).toBe(v2.id);
        }),
      ),
    { timeout: 30_000 },
  );

  it.effect(
    "list with non-default comparison operators (gt, lte)",
    () =>
      isolated((worker) =>
        Effect.gen(function* () {
          const videoUrl = yield* useServer(
            staticBytesListener(TEST_VIDEO_BYTES),
          );
          const object = new ControlStub(worker.baseUrl);
          yield* Effect.promise(() => object.enableFakeTimers(FAKE_TIME_START));

          const v1 = yield* uploadVideo(worker, videoUrl); // t=0
          yield* Effect.promise(() => object.advanceFakeTime(10_000));
          const v2 = yield* uploadVideo(worker, videoUrl); // t=10s

          // afterComp=gt with v1's exact created time should NOT include v1
          const afterGtResult = yield* sendCmd<Array<Video>>(
            worker,
            "videos.list",
            {
              params: { after: v1.created, afterComp: "gt" },
            },
          );
          expect(afterGtResult.map((video) => video.id)).not.toContain(v1.id);
          expect(afterGtResult.map((video) => video.id)).toContain(v2.id);

          // beforeComp=lte with v1's exact created time should include v1
          const beforeLteResult = yield* sendCmd<Array<Video>>(
            worker,
            "videos.list",
            {
              params: { before: v1.created, beforeComp: "lte" },
            },
          );
          expect(beforeLteResult.map((video) => video.id)).toContain(v1.id);
          expect(beforeLteResult.map((video) => video.id)).not.toContain(v2.id);
        }),
      ),
    { timeout: 30_000 },
  );
});

describe("Stream watermarks list", () => {
  it.effect(
    "list watermarks",
    () =>
      isolated((worker) =>
        Effect.gen(function* () {
          const imageUrl = yield* useServer(
            staticBytesListener(TEST_IMAGE_BYTES),
          );

          yield* sendCmd(worker, "watermarks.generate", {
            url: imageUrl.toString(),
            params: { name: "wm1" },
          });
          yield* sendCmd(worker, "watermarks.generate", {
            url: imageUrl.toString(),
            params: { name: "wm2" },
          });

          const list = yield* sendCmd<Array<Watermark>>(
            worker,
            "watermarks.list",
          );
          expect(list).toHaveLength(2);
          const names = list.map((watermark) => watermark.name);
          expect(names).toContain("wm1");
          expect(names).toContain("wm2");
        }),
      ),
    { timeout: 30_000 },
  );

  it.effect(
    "delete watermark",
    () =>
      isolated((worker) =>
        Effect.gen(function* () {
          const imageUrl = yield* useServer(
            staticBytesListener(TEST_IMAGE_BYTES),
          );

          const watermark = yield* sendCmd<Watermark>(
            worker,
            "watermarks.generate",
            {
              url: imageUrl.toString(),
              params: { name: "delete-me" },
            },
          );
          yield* sendCmd(worker, "watermarks.delete", { id: watermark.id });

          const list = yield* sendCmd<Array<Watermark>>(
            worker,
            "watermarks.list",
          );
          expect(list).toHaveLength(0);
        }),
      ),
    { timeout: 30_000 },
  );
});

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

describe("Stream binding persistence", () => {
  it.effect(
    "persists on file-system",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const tmp = yield* makeTempDirectory("stream-persist-");

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
          function* (run: (worker: TestWorker) => Effect.Effect<void, Error>) {
            const worker = yield* makeStreamWorker("stream-persist-test");
            yield* run(worker);
          },
          (self) =>
            self.pipe(Effect.provide(runtimeLayerTempDir), Effect.scoped),
        );

        let videoId: string | undefined;

        yield* runAgainstStorage((worker) =>
          Effect.gen(function* () {
            const videoUrl = yield* useServer(
              staticBytesListener(TEST_VIDEO_BYTES),
            );
            const video = yield* uploadVideo(worker, videoUrl);
            videoId = video.id;
            expect(video.size).toBe(TEST_VIDEO_BYTES.byteLength);
          }).pipe(Effect.scoped),
        );

        // Directories created for the Durable Object SQLite database and the
        // blob store, mirroring the KV/R2 persistence layout under a distinct
        // `stream` root.
        const names = yield* fs.readDirectory(path.join(tmp, "stream"));
        expect(names).toContain(
          `cloudflare-runtime-${Stream.STREAM_OBJECT_CLASS_NAME}`,
        );
        expect(names).toContain(Stream.STREAM_OBJECT_NAME);

        // "Restarting" keeps persisted data, and the preview route still
        // serves the stored bytes.
        yield* runAgainstStorage((worker) =>
          Effect.gen(function* () {
            assert(videoId);
            const details = yield* sendCmd<Video>(worker, "video.details", {
              id: videoId,
            });
            expect(details.id).toBe(videoId);
            expect(details.size).toBe(TEST_VIDEO_BYTES.byteLength);

            const resp = yield* worker.fetch(
              `/cdn-cgi/mf/stream/${videoId}/watch`,
            );
            const bytes = new Uint8Array(
              yield* Effect.promise(() => resp.arrayBuffer()),
            );
            expect(resp.status).toBe(200);
            expect(bytes).toEqual(TEST_VIDEO_BYTES);
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 60_000 },
  );
});
