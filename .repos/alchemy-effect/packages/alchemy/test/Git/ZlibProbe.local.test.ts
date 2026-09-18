import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import ZlibProbeWorker from "./fixtures/zlib-probe-worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const Stack = Alchemy.Stack(
  "ZlibProbeStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* ZlibProbeWorker;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll(destroy(Stack));

test(
  "workerd node:zlib keeps the synchronous exact-span inflate the pack parser relies on",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(`${url}/?path=probe`);
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
      const n = path.startsWith("deflate") ? 200 : 2000;
      yield* client
        .get(`${url}/?path=${path}&n=50`)
        .pipe(Effect.flatMap((r) => r.json));
      const t0 = performance.now();
      const r = (yield* client
        .get(`${url}/?path=${path}&n=${n}`)
        .pipe(Effect.flatMap((r) => r.json))) as { ok: number; error?: string };
      const ms = performance.now() - t0;
      console.log(
        `[zlib-local] ${path.padEnd(12)} ok ${r.ok}/${n} in ${ms.toFixed(0)}ms → ${(ms / n).toFixed(3)} ms/entry${r.error ? ` error: ${r.error}` : ""}`,
      );
    }
    const body = (yield* res.json) as {
      hasProcessChunk: boolean;
      info?: { outLen: number; bytesWritten: number; expectedConsumed: number };
      contentLen: number;
    };
    console.log("[zlib-probe]", JSON.stringify(body));
    expect(res.status).toBe(200);
    // PackParser's per-entry inflate takes the synchronous `_processChunk`
    // fast path (Zlib.ts); a workerd without it falls back to a streaming
    // inflater measured ~50x slower per object. Pin it.
    expect(body.hasProcessChunk).toBe(true);
    expect(body.info?.outLen).toBe(body.contentLen);
    expect(body.info?.bytesWritten).toBe(body.info?.expectedConsumed);
  }),
  { timeout: 60_000 },
);
