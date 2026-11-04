import * as Cloudflare from "@alchemy.run/cloudflare";
import { encodeRpcError } from "@alchemy.run/cloudflare/Workers/Rpc";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Stream from "effect/Stream";
import BindingTargetWorker, { streamScenarios } from "./binding-target-worker.ts";

/**
 * Effect-native worker that calls another Effect-native worker's RPC method
 * via `Cloudflare.Workers.bindWorker`. This is the canonical Effect → Effect cross-
 * worker pattern: the bound stub returns Effects, errors and streams flow
 * back through the typed channel.
 *
 * GET /?name=foo  →  pipes the bound `greet(name)` Effect through.
 */
export default class BindingEffectCaller extends Cloudflare.Worker<BindingEffectCaller>()(
  "BindingEffectCaller",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    const target = yield* Cloudflare.Workers.bindWorker(BindingTargetWorker);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/rpc-stream-ready") {
          return HttpServerResponse.text(yield* target.scopedStreamReady());
        }
        if (url.pathname.startsWith("/rpc-stream/")) {
          const [, , encoding, mode] = url.pathname.split("/");
          const scenario = streamScenarios.find((value) => value === mode);
          if (!scenario || (encoding !== "json" && encoding !== "bytes")) {
            return HttpServerResponse.text("Unknown stream scenario", { status: 400 });
          }
          const chunks: string[] = [];
          const exit = yield* Effect.gen(function* () {
            const source = yield* target.scopedStream(encoding === "bytes", scenario);
            const lines = source.pipe(
              Stream.map((value) =>
                value instanceof Uint8Array
                  ? value
                  : new TextEncoder().encode(`${JSON.stringify(value)}\n`),
              ),
              Stream.decodeText,
              Stream.splitLines,
              Stream.filter((line) => line.length > 0),
            );
            // Native byte-stream chunks need not coincide with JSON records.
            // Cancel after one complete record, even if the head is split.
            yield* (scenario === "cancel" ? lines.pipe(Stream.take(1)) : lines).pipe(
              Stream.runForEach((value) =>
                Effect.sync(() => {
                  chunks.push(value);
                }),
              ),
            );
          }).pipe(Effect.timeout("5 seconds"), Effect.exit);
          const after = yield* target.greet("after stream");
          return yield* HttpServerResponse.json({
            values: chunks.map((line) => JSON.parse(line)),
            failed: Exit.isFailure(exit),
            error: Exit.isFailure(exit) ? encodeRpcError(Cause.squash(exit.cause)) : undefined,
            after,
          });
        }
        const name = url.searchParams.get("name") ?? "world";
        const greeting = yield* target.greet(name);
        return HttpServerResponse.text(String(greeting));
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(`effect caller failed: ${String(cause)}`, {
              status: 500,
            }),
          ),
        ),
      ),
    };
  }),
) {}
