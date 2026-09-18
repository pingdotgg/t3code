/**
 * `Hasher` over an AWS Lambda (DESIGN §22.11). Each chunk is one
 * `InvokeFunction` call — a JSON payload with the chunk in base64 — signed
 * from the Worker with the cross-cloud identity `AWS.Lambda.InvokeFunctionHttp`
 * provisions for a Worker host (an IAM user, key and assume-role Role,
 * once per Worker). Chunks are 4 MiB (the 6 MB invoke limit) and the pump
 * writes the spill parts itself (`writesSpill: false`). Any failure on the
 * Lambda side — throttling, a cold-start timeout, an oversize response —
 * falls back to hashing that chunk inline, so a push never fails because
 * the hasher did.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { InvokeFunction } from "../../AWS/Lambda/InvokeFunction.ts";
import type { Function as LambdaFunction } from "../../AWS/Lambda/Function.ts";
import {
  hashBounds,
  resolveDeltas,
  scanPart,
} from "../Protocol/PartialScan.ts";
import { Hasher, HashError, type HasherShape } from "./Hasher.ts";
import {
  decodeHashResponse,
  encodeHashEvent,
  LAMBDA_CHUNK_BYTES,
  type HashResponse,
} from "./LambdaEvent.ts";

export const HasherLambda = (
  fn: LambdaFunction | Effect.Effect<LambdaFunction, any, any>,
): Layer.Layer<Hasher, never, InvokeFunction> =>
  Layer.effect(
    Hasher,
    Effect.gen(function* () {
      // A class-style declaration (`HasherFunction`) is yielded here — at
      // deploy that registers the function, at runtime it resolves it.
      const func = Effect.isEffect(fn)
        ? yield* fn as Effect.Effect<LambdaFunction>
        : fn;
      const invoke = yield* InvokeFunction(func);
      const remote = (
        payload: Uint8Array,
        options: Parameters<HasherShape["hashPart"]>[1],
      ) =>
        Effect.gen(function* () {
          const response = yield* invoke({
            Payload: JSON.stringify(encodeHashEvent(payload, options)),
          }).pipe(
            Effect.mapError(
              (error) =>
                new HashError({
                  reason: `lambda invoke: ${error._tag}${"message" in error ? `: ${String(error.message)}` : ""}`,
                }),
            ),
          );
          if (response.FunctionError !== undefined) {
            return yield* new HashError({
              reason: `lambda hasher: ${response.FunctionError}`,
            });
          }
          const chunks = response.Payload
            ? Array.from(
                yield* Stream.runCollect(response.Payload).pipe(
                  Effect.mapError(
                    (error) =>
                      new HashError({
                        reason: `lambda response: ${String(error)}`,
                      }),
                  ),
                ),
              )
            : [];
          const text = new TextDecoder().decode(
            chunks.length === 1 ? chunks[0] : concat(chunks),
          );
          const parsed = yield* Effect.try({
            try: () => JSON.parse(text) as HashResponse,
            catch: () => new HashError({ reason: `lambda response: not JSON` }),
          });
          return yield* decodeHashResponse(parsed);
        });
      return {
        writesSpill: false,
        chunkBytes: LAMBDA_CHUNK_BYTES,
        hashPart: (payload, options) =>
          // A region larger than a chunk (a big object straddling parts)
          // cannot fit the invoke payload: hash it here without the trip.
          (payload.length > LAMBDA_CHUNK_BYTES
            ? Effect.fail(
                new HashError({
                  reason: `payload of ${payload.length} bytes exceeds the invoke limit`,
                }),
              )
            : remote(payload, options)
          ).pipe(
            Effect.catchTag("HashError", (error) => {
              if (payload.length <= LAMBDA_CHUNK_BYTES) {
                console.warn(`[hasher] ${error.reason}; hashing inline`);
              }
              const skip = options.skip ?? 0;
              return scanPart(
                skip > 0 ? payload.subarray(skip) : payload,
                options,
              );
            }),
          ),
        // Delta batches stay on the receiver for now: a batch would need the
        // same base64 event budget as a chunk.
        resolveDeltas: (bases, jobs, options) =>
          resolveDeltas(bases, jobs, options),
        hashBoundsPart: (payload, bounds, options) =>
          hashBounds(payload, bounds, options),
      } satisfies HasherShape;
    }),
  );

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};
