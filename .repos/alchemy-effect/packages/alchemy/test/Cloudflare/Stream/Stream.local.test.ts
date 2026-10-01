import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as pathe from "pathe";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Mock video bytes — the same checked-in constant the runtime's own Stream
 * binding test uses (adopted from Miniflare's stream plugin tests). The local
 * simulator is a byte store: it accepts any payload and serves it unmodified.
 */
const TEST_VIDEO_BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

/**
 * POST bytes to a fixture route, retrying until the worker serves a 200
 * (fresh dev workers can briefly 503 while workerd boots). Non-200s carry the
 * body so a persistent fixture error surfaces.
 */
const postBytesReady = (url: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client
      .execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.bodyUint8Array(bytes),
        ),
      )
      .pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : res.text.pipe(
                Effect.flatMap((body) =>
                  Effect.fail(new WorkerNotReady({ status: res.status, body })),
                ),
              ),
        ),
        Effect.retry({
          while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
          schedule: Schedule.max([
            Schedule.min([
              Schedule.exponential("500 millis"),
              Schedule.spaced("2 seconds"),
            ]),
            Schedule.recurs(10),
          ]),
        }),
      );
  }).pipe(Effect.orDie);

const fixtureMain = pathe.resolve(
  import.meta.dirname,
  "fixtures/local-worker.ts",
);

interface VideoResponse {
  id: string;
  creator: string | null;
  meta: Record<string, string>;
  readyToStream: boolean;
  status: { state: string };
  size: number;
  preview: string;
  hlsPlaybackUrl?: string;
  dashPlaybackUrl?: string;
}

interface ErrorEnvelope {
  error: boolean;
  code?: number;
  statusCode?: number;
  message: string;
}

/**
 * Under `alchemy dev` the `stream` binding is emulated by cloudflare-runtime:
 * uploads land in a local video store (shared across the runtime's workers,
 * persisted with disk-backed storage) and each video's `preview` URL is
 * served unmodified at `/cdn-cgi/mf/stream/<id>/watch` — no Cloudflare
 * credentials or preview session are involved for the binding. Fidelity
 * limits (mirroring Miniflare): no transcoding/HLS ladder, no signed URLs,
 * no direct creator uploads.
 */
test.provider(
  "stream binding round-trips against the local video-store simulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("stream-local-worker", {
            main: fixtureMain,
            env: { STREAM: Cloudflare.Stream.Stream("STREAM") },
          });
          return { url: worker.url.as<string>() };
        }),
      );

      // Served from the local dev proxy — proof the worker runs locally.
      expect(deployed.url).toMatch(/^http:\/\/localhost:\d+$/);

      const client = yield* HttpClient.HttpClient;

      // Upload through the binding (the local simulator accepts the raw
      // request body bytes in place of a URL, like Miniflare).
      const uploadRes = yield* postBytesReady(
        `${deployed.url}/upload`,
        TEST_VIDEO_BYTES,
      );
      const video = (yield* uploadRes.json) as unknown as VideoResponse;
      expect(video.id).toBeTruthy();
      expect(video.readyToStream).toBe(true);
      expect(video.status.state).toBe("ready");
      expect(video.size).toBe(TEST_VIDEO_BYTES.byteLength);
      expect(video.creator).toBe("alchemy");
      expect(video.meta).toEqual({ title: "alchemy-local-test" });
      // The preview URL is the local watch route on the runtime entry.
      expect(video.preview).toMatch(
        new RegExp(
          `^http://127\\.0\\.0\\.1:\\d+/cdn-cgi/mf/stream/${video.id}/watch$`,
        ),
      );

      // Read it back through the binding.
      const detailsRes = yield* client.get(
        `${deployed.url}/details?id=${video.id}`,
      );
      const details = (yield* detailsRes.json) as unknown as VideoResponse;
      expect(details.id).toBe(video.id);
      expect(details.size).toBe(TEST_VIDEO_BYTES.byteLength);

      // The stored bytes are served at the watch route, both through the
      // dev URL (the stream router middleware in front of the user worker)…
      const watchRes = yield* client.get(
        `${deployed.url}/cdn-cgi/mf/stream/${video.id}/watch`,
      );
      expect(watchRes.status).toBe(200);
      const watchBytes = new Uint8Array(yield* watchRes.arrayBuffer);
      expect(Array.from(watchBytes)).toEqual(Array.from(TEST_VIDEO_BYTES));

      // …and at the video's own preview URL.
      const previewRes = yield* client.get(video.preview);
      expect(previewRes.status).toBe(200);
      const previewBytes = new Uint8Array(yield* previewRes.arrayBuffer);
      expect(Array.from(previewBytes)).toEqual(Array.from(TEST_VIDEO_BYTES));

      // Delete through the binding; details now surfaces the simulator's
      // typed not-found error (code 10003).
      const deleteRes = yield* client.get(
        `${deployed.url}/delete?id=${video.id}`,
      );
      expect(((yield* deleteRes.json) as { deleted: boolean }).deleted).toBe(
        true,
      );
      const goneRes = yield* client.get(
        `${deployed.url}/details?id=${video.id}`,
      );
      const gone = (yield* goneRes.json) as unknown as ErrorEnvelope;
      expect(gone.error).toBe(true);
      expect(gone.message).toContain("Video not found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
