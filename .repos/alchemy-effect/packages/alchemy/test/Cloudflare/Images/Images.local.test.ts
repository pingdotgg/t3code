import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
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

/** 8x4 solid red PNG (checked-in fixture, generated once with Sharp). */
const PNG_RED_8X4 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVR4nGP4z8CAFWEXJUsCAFpeH+EeQoQoAAAAAElFTkSuQmCC",
    "base64",
  ),
);

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

interface InfoResponse {
  format: string;
  fileSize: number;
  width: number;
  height: number;
}

/**
 * Under `alchemy dev` the `images` binding is emulated by cloudflare-runtime:
 * the wrapped `cloudflare-internal:images-api` module targets a local service
 * that runs pixel work (resize/rotate/transcode) via Sharp on this machine —
 * no Cloudflare credentials or preview session are involved for the binding.
 */
test.provider(
  "images binding round-trips against the local Sharp simulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("images-local-worker", {
            main: fixtureMain,
            env: { IMAGES: Cloudflare.Images.Images("IMAGES") },
          });
          return { url: worker.url.as<string>() };
        }),
      );

      // Served from the local dev proxy — proof the worker runs locally.
      expect(deployed.url).toMatch(/^http:\/\/localhost:\d+$/);

      // info() reads format and dimensions through the local simulator.
      const infoRes = yield* postBytesReady(
        `${deployed.url}/info`,
        PNG_RED_8X4,
      );
      const info = (yield* infoRes.json) as unknown as InfoResponse;
      expect(info.format).toBe("image/png");
      expect(info.width).toBe(8);
      expect(info.height).toBe(4);

      // input().transform({ width }).output() resizes via Sharp; the output
      // is a real PNG (magic bytes)...
      const transformRes = yield* postBytesReady(
        `${deployed.url}/transform?width=4&format=image/png`,
        PNG_RED_8X4,
      );
      expect(transformRes.headers["content-type"]).toBe("image/png");
      const outputBytes = new Uint8Array(yield* transformRes.arrayBuffer);
      expect(Array.from(outputBytes.slice(0, 4))).toEqual([
        0x89, 0x50, 0x4e, 0x47,
      ]);

      // ...and info() on the output confirms the resize (contain-fit keeps
      // the 2:1 aspect ratio: 8x4 -> 4x2).
      const outputInfoRes = yield* postBytesReady(
        `${deployed.url}/info`,
        outputBytes,
      );
      const outputInfo = (yield* outputInfoRes.json) as unknown as InfoResponse;
      expect(outputInfo.format).toBe("image/png");
      expect(outputInfo.width).toBe(4);
      expect(outputInfo.height).toBe(2);

      // GIF output surfaces the documented local-mode 415 (code 9520).
      const gifRes = yield* postBytesReady(
        `${deployed.url}/transform?format=image/gif`,
        PNG_RED_8X4,
      );
      const gifBody = (yield* gifRes.json) as {
        error: boolean;
        code: number;
        message: string;
      };
      expect(gifBody.error).toBe(true);
      expect(gifBody.code).toBe(9520);
      expect(gifBody.message).toContain(
        "GIF output is not supported in local mode",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

/**
 * `Alchemy.remote()` opts the binding OUT of local emulation: the
 * locally-served worker drives the real Images service through the
 * remote-bindings preview session. The live suite
 * (test/Cloudflare/Images/Images.test.ts) covers deployed-binding behavior;
 * this leg pins the dev-mode remote lowering path.
 */
test.provider(
  "Alchemy.remote() proxies the binding to the real Images service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("images-remote-worker", {
            main: fixtureMain,
            env: {
              IMAGES: Cloudflare.Images.Images("IMAGES").pipe(Alchemy.remote()),
            },
          });
          return { url: worker.url.as<string>() };
        }),
      );

      // Still served locally — only the binding is remote.
      expect(deployed.url).toMatch(/^http:\/\/localhost:\d+$/);

      const infoRes = yield* postBytesReady(
        `${deployed.url}/info`,
        PNG_RED_8X4,
      );
      const info = (yield* infoRes.json) as unknown as InfoResponse;
      expect(info.format).toBe("image/png");
      expect(info.width).toBe(8);
      expect(info.height).toBe(4);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
