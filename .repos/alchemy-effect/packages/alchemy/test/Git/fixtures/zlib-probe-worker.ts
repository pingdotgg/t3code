/**
 * Probe fixture: what does THIS workerd's `node:zlib` offer for a
 * synchronous, exact-span inflate, and what does each path cost? (See
 * `src/Git/Protocol/Zlib.ts`.) `?n=<count>` runs each path that many times so
 * the CLIENT can measure wall time — workerd freezes `performance.now()`
 * during synchronous work, so the worker cannot time itself.
 */
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import crypto from "node:crypto";
import zlib from "node:zlib";

const streamInflate = (z: Uint8Array) =>
  new Promise<number>((resolve, reject) => {
    const engine = zlib.createInflate();
    let out = 0;
    engine.on("data", (chunk: Uint8Array) => {
      out += chunk.length;
    });
    engine.on("end", () => resolve(out));
    engine.on("error", reject);
    engine.end(z);
  });

export default class ZlibProbeWorker extends Cloudflare.Worker<ZlibProbeWorker>()(
  "ZlibProbeWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const n = Number(url.searchParams.get("n") ?? "0");
        const which = url.searchParams.get("path") ?? "probe";
        const content = new TextEncoder().encode("hello ".repeat(500));
        const z = new Uint8Array(zlib.deflateSync(content));
        const withTrailer = new Uint8Array(z.length + 7);
        withTrailer.set(z, 0);
        withTrailer.set([1, 2, 3, 4, 5, 6, 7], z.length);

        if (which === "probe") {
          const engine = zlib.createInflate() as unknown as {
            _processChunk?: unknown;
            close?: () => void;
          };
          const hasProcessChunk = typeof engine._processChunk === "function";
          engine.close?.();
          let info: unknown;
          let infoError: string | undefined;
          try {
            const r = zlib.inflateSync(withTrailer, {
              info: true,
            } as never) as unknown as {
              buffer: Uint8Array;
              engine: { bytesWritten?: number };
            };
            info = {
              outLen: r.buffer?.length,
              bytesWritten: r.engine?.bytesWritten,
              expectedConsumed: z.length,
            };
          } catch (e) {
            infoError = String(e);
          }
          return HttpServerResponse.jsonUnsafe({
            hasProcessChunk,
            info,
            infoError,
            contentLen: content.length,
          });
        }
        let ok = 0;
        let error: string | undefined;
        try {
          if (which === "processChunk") {
            for (let i = 0; i < n; i++) {
              const engine = zlib.createInflate() as unknown as {
                _processChunk: (chunk: Uint8Array, flush: number) => Uint8Array;
                bytesWritten?: number;
                close?: () => void;
              };
              const out = engine._processChunk(
                withTrailer,
                zlib.constants.Z_SYNC_FLUSH,
              );
              if (
                out.length === content.length &&
                engine.bytesWritten === z.length
              )
                ok++;
              engine.close?.();
            }
          } else if (which === "processChunkReuse") {
            // ONE engine for all entries: _processChunk, read the consumed
            // delta from the cumulative bytesWritten, then reset().
            const engine = zlib.createInflate() as unknown as {
              _processChunk: (chunk: Uint8Array, flush: number) => Uint8Array;
              bytesWritten: number;
              reset: () => void;
              close?: () => void;
            };
            let consumedBefore = 0;
            for (let i = 0; i < n; i++) {
              const out = engine._processChunk(
                withTrailer,
                zlib.constants.Z_SYNC_FLUSH,
              );
              const consumed = engine.bytesWritten - consumedBefore;
              consumedBefore = engine.bytesWritten;
              if (out.length === content.length && consumed === z.length) ok++;
              engine.reset();
            }
            engine.close?.();
          } else if (which === "info") {
            for (let i = 0; i < n; i++) {
              const r = zlib.inflateSync(withTrailer, {
                info: true,
              } as never) as unknown as {
                buffer: Uint8Array;
                engine: { bytesWritten?: number };
              };
              if (
                r.buffer.length === content.length &&
                r.engine.bytesWritten === z.length
              )
                ok++;
            }
          } else if (which === "plain") {
            for (let i = 0; i < n; i++) {
              if (zlib.inflateSync(z).length === content.length) ok++;
            }
          } else if (which === "sha1") {
            for (let i = 0; i < n; i++) {
              const h = crypto.createHash("sha1");
              h.update(content);
              if (h.digest().length === 20) ok++;
            }
          } else if (which === "deflate6") {
            const big = new Uint8Array(30 * 1024);
            for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
            for (let i = 0; i < n; i++) {
              if (zlib.deflateSync(big, { level: 6 }).length > 0) ok++;
            }
          } else if (which === "deflate1") {
            const big = new Uint8Array(30 * 1024);
            for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
            for (let i = 0; i < n; i++) {
              if (zlib.deflateSync(big, { level: 1 }).length > 0) ok++;
            }
          } else if (which === "copy") {
            for (let i = 0; i < n; i++) {
              if (
                Uint8Array.from(content.subarray(1)).length ===
                content.length - 1
              )
                ok++;
            }
          } else if (which === "jsloop") {
            // A delta-apply-shaped loop: byte copies with small varint reads.
            const out = new Uint8Array(content.length);
            for (let i = 0; i < n; i++) {
              let at = 0;
              for (let j = 0; j < content.length; j += 16) {
                const len = Math.min(16, content.length - j);
                out.set(content.subarray(j, j + len), at);
                at += len;
              }
              if (at === content.length) ok++;
            }
          } else if (which === "effect") {
            ok = yield* Effect.gen(function* () {
              let k = 0;
              for (let i = 0; i < n; i++) {
                const v = yield* Effect.gen(function* () {
                  let acc = 0;
                  for (let j = 0; j < 20; j++)
                    acc += yield* Effect.sync(() => j);
                  return acc;
                });
                if (v === 190) k++;
              }
              return k;
            });
          } else if (which === "stream") {
            ok = yield* Effect.promise(async () => {
              let k = 0;
              for (let i = 0; i < n; i++)
                if ((await streamInflate(z)) === content.length) k++;
              return k;
            });
          }
        } catch (e) {
          error = String(e);
        }
        return HttpServerResponse.jsonUnsafe({ path: which, n, ok, error });
      }),
    };
  }),
) {}
