/**
 * The same probe as ZlibProbe.local.test.ts, against REAL Cloudflare: which
 * synchronous exact-span inflate paths exist in production workerd, and
 * what each costs per entry (client-measured wall time over 2,000 entries).
 * DESIGN §22.4: this is what decides the push-ingest CPU story.
 */
import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import ZlibProbeWorker from "./fixtures/zlib-probe-worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const Stack = Alchemy.Stack(
  "ZlibProbeCloudStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* ZlibProbeWorker;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "production workerd: which exact-span inflate paths work, and their cost",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const get = (q: string) =>
      client.get(`${url}/?${q}`).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json
            : Effect.fail(new Error(`status ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
    const probe = (yield* get("path=probe")) as Record<string, unknown>;
    console.log("[zlib-cloud] probe", JSON.stringify(probe));
    const N = 2000;
    const nFor = (path: string) => (path.startsWith("deflate") ? 200 : N);
    for (const path of [
      "processChunk",
      "processChunkReuse",
      "info",
      "plain",
      "stream",
      "sha1",
      "copy",
      "jsloop",
      "effect",
      "deflate6",
      "deflate1",
    ]) {
      yield* get(`path=${path}&n=50`); // warm
      const t0 = performance.now();
      const n = nFor(path);
      const r = (yield* get(`path=${path}&n=${n}`)) as {
        ok: number;
        error?: string;
      };
      const ms = performance.now() - t0;
      console.log(
        `[zlib-cloud] ${path.padEnd(12)} ok ${r.ok}/${n} in ${ms.toFixed(0)}ms → ${(ms / n).toFixed(3)} ms/entry${r.error ? ` error: ${r.error}` : ""}`,
      );
    }
    expect(probe).toBeDefined();
  }),
  { timeout: 300_000 },
);
