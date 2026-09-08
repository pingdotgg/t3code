import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type * as Binding from "../Workers/Binding.ts";
import { makeBindingLayer } from "../Workers/BindingLayer.ts";
import {
  Stream,
  StreamError,
  type StreamClient,
  type StreamVideoClient,
} from "./Stream.ts";

/** The binding value produced by calling {@link Stream} (declared on `env` or `yield*`-ed). */
export type StreamBinding = Binding.Binding<
  Stream["key"],
  StreamClient,
  Stream
>;

/**
 * The layer that provides the Effect-native interface for the Cloudflare
 * Stream binding.
 *
 * Provide it on the Worker effect (`Effect.provide(Cloudflare.Stream.StreamBinding)`)
 * so that yielding a {@link Stream} binding attaches the native `stream`
 * binding to the surrounding Worker at deploy time and, at runtime, resolves to
 * the Effect-native {@link StreamClient} (wrapping the raw `cf.StreamBinding`
 * handle so every operation returns an `Effect`).
 */
export const StreamBinding = makeBindingLayer<
  Stream,
  cf.StreamBinding,
  StreamClient
>(Stream, (raw): StreamClient => {
  const call = <T>(
    fn: (binding: cf.StreamBinding) => Promise<T>,
  ): Effect.Effect<T, StreamError, RuntimeContext> =>
    raw.pipe(Effect.flatMap((binding) => tryPromise(() => fn(binding))));

  const video = (id: string): StreamVideoClient => ({
    id,
    details: () => call((binding) => binding.video(id).details()),
    update: (params) => call((binding) => binding.video(id).update(params)),
    delete: () => call((binding) => binding.video(id).delete()),
    generateToken: () => call((binding) => binding.video(id).generateToken()),
    downloads: {
      generate: (downloadType) =>
        call((binding) => binding.video(id).downloads.generate(downloadType)),
      get: () => call((binding) => binding.video(id).downloads.get()),
      delete: (downloadType) =>
        call((binding) => binding.video(id).downloads.delete(downloadType)),
    },
    captions: {
      upload: (language, input) =>
        call((binding) =>
          binding
            .video(id)
            .captions.upload(language, input as unknown as cf.ReadableStream),
        ),
      generate: (language) =>
        call((binding) => binding.video(id).captions.generate(language)),
      list: (language) =>
        call((binding) => binding.video(id).captions.list(language)),
      delete: (language) =>
        call((binding) => binding.video(id).captions.delete(language)),
    },
  });

  return {
    raw,
    upload: (url, params) => call((binding) => binding.upload(url, params)),
    createDirectUpload: (params) =>
      call((binding) => binding.createDirectUpload(params)),
    video,
    videos: {
      list: (params) => call((binding) => binding.videos.list(params)),
    },
    watermarks: {
      generate: (input, params) =>
        call((binding) =>
          // The runtime accepts a stream or a URL string for the first
          // argument; the published types declare the two as overloads.
          binding.watermarks.generate(
            input as unknown as cf.ReadableStream,
            params,
          ),
        ),
      list: () => call((binding) => binding.watermarks.list()),
      get: (watermarkId) =>
        call((binding) => binding.watermarks.get(watermarkId)),
      delete: (watermarkId) =>
        call((binding) => binding.watermarks.delete(watermarkId)),
    },
  } satisfies StreamClient;
});

const tryPromise = <T>(fn: () => Promise<T>): Effect.Effect<T, StreamError> =>
  Effect.tryPromise({
    try: fn,
    catch: (error: any) =>
      new StreamError({
        message: error?.message ?? "Unknown Cloudflare Stream error",
        code: typeof error?.code === "number" ? error.code : undefined,
        statusCode:
          typeof error?.statusCode === "number" ? error.statusCode : undefined,
        cause: error,
      }),
  });
