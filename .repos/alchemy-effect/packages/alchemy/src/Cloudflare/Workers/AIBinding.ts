/// <reference types="@cloudflare/workers-types" />

import * as Effect from "effect/Effect";
import { makeLanguageModelLayer } from "../AI/LanguageModel.ts";
import { AI, WorkersAIError, type AIClient } from "./AI.ts";
import * as Binding from "./Binding.ts";
import { makeBindingLayer } from "./BindingLayer.ts";

/** The binding value produced by calling {@link AI} (declared on `env` or `yield*`-ed). */
export type AIBinding = Binding.Binding<AI["key"], AIClient, AI>;

/**
 * The layer that provides the Effect-native interface for the Cloudflare
 * Workers AI binding.
 *
 * Provide it on the Worker effect (`Effect.provide(Cloudflare.Workers.AIBinding)`)
 * so that yielding an {@link AI} binding attaches the native `ai` binding to
 * the surrounding Worker at deploy time and, at runtime, resolves to the
 * Effect-native {@link AIClient} (wrapping the raw `Ai` handle so `run` /
 * `models` return Effects and `model(...)` yields a `LanguageModel` layer).
 */
export const AIBinding = makeBindingLayer<AI, Ai, AIClient>(AI, (raw) => {
  const self: AIClient = {
    raw,
    run: (model, inputs, options) =>
      Effect.gen(function* () {
        const ai = yield* raw;
        return yield* tryPromise(() => ai.run(model, inputs, options));
      }),
    models: (params) =>
      Effect.gen(function* () {
        const ai = yield* raw;
        return yield* tryPromise(() => ai.models(params));
      }),
    model: (options) =>
      makeLanguageModelLayer({
        ...options,
        client: self,
      }),
  };
  return self;
});

const tryPromise = <T>(
  fn: () => Promise<T>,
): Effect.Effect<T, WorkersAIError> =>
  Effect.tryPromise({
    try: fn,
    catch: (error) =>
      new WorkersAIError({
        message:
          error instanceof Error
            ? error.message
            : "Unknown Workers AI runtime error",
        cause: error,
      }),
  });
