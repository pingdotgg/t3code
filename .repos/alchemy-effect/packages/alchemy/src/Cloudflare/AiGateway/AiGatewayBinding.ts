/// <reference types="@cloudflare/workers-types" />

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { LanguageModel } from "effect/unstable/ai/LanguageModel";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { isWorker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { AiGateway as AiGatewayResource } from "./AiGateway.ts";
import {
  makeLanguageModelLayer,
  type LanguageModelOptions,
} from "./LanguageModel.ts";

// Error raised by AI Gateway runtime operations.
export class AiGatewayError extends Data.TaggedError("AiGatewayError")<{
  /**
   * Human-readable runtime error message.
   */
  message: string;
  /**
   * Original error thrown by the Cloudflare runtime binding.
   */
  cause: unknown;
}> {}

/**
 * Effect-native client for a Cloudflare AI Gateway Worker binding.
 *
 * Wraps the runtime {@link AiGateway} binding so each operation returns an
 * Effect tagged with {@link AiGatewayError}. Use
 * `Cloudflare.AiGatewayBinding.bind(gateway)` inside a Worker's init phase.
 */
export interface AiGatewayClient {
  /**
   * Effect resolving to the raw Workers AI binding.
   */
  raw: Effect.Effect<Ai, never, RuntimeContext>;
  /**
   * Effect resolving to the raw AI Gateway runtime binding.
   */
  gateway: Effect.Effect<AiGateway, never, RuntimeContext>;
  /**
   * Effect resolving to the gateway id (the resource attribute, captured at
   * bind time). Useful when calling `ai.run(model, inputs, { gateway: { id } })`
   * — the in-account path for first-party services like Workers AI.
   */
  id: Effect.Effect<string, never, RuntimeContext>;
  /**
   * Update metadata on an existing AI Gateway log entry.
   */
  patchLog(
    logId: string,
    data: Parameters<AiGateway["patchLog"]>[1],
  ): Effect.Effect<void, AiGatewayError, RuntimeContext>;
  /**
   * Read an AI Gateway log entry by ID.
   */
  getLog(
    logId: string,
  ): Effect.Effect<AiGatewayLog, AiGatewayError, RuntimeContext>;
  /**
   * Build a provider URL routed through this gateway.
   */
  getUrl(
    provider?: Parameters<AiGateway["getUrl"]>[0],
  ): Effect.Effect<string, AiGatewayError, RuntimeContext>;
  /**
   * Run an AI Gateway request through the Cloudflare runtime binding.
   */
  run(
    data: Parameters<AiGateway["run"]>[0],
    options?: Parameters<AiGateway["run"]>[1],
  ): Effect.Effect<Response, AiGatewayError, RuntimeContext>;

  model(
    options: LanguageModelOptions,
  ): Layer.Layer<LanguageModel, never, RuntimeContext>;
}

/**
 * Binding service that turns an {@link AiGatewayResource} resource
 * into a typed {@link AiGatewayClient} for Worker runtime code. Wraps
 * the Cloudflare AI Gateway runtime binding so each operation returns
 * an Effect tagged with {@link AiGatewayError}, exposes the raw
 * Workers AI handle for `ai.run(...)`, and provides a `model(options)`
 * factory that produces an `effect/unstable/ai` `LanguageModel`
 * `Layer`.
 *
 * @binding
 *
 * @section Calling AI Gateway
 * @example Run through a gateway
 * Bind the gateway during the Worker's init phase, then use `run` or
 * `getUrl` from request handlers.
 * ```typescript
 * const aiGateway = yield* Cloudflare.AiGatewayBinding.bind(gateway);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     return yield* aiGateway.run({
 *       provider: "workers-ai",
 *       endpoint: "@cf/meta/llama-3.1-8b-instruct",
 *       headers: { "content-type": "application/json" },
 *       query: { prompt: "Write a concise status update" },
 *     });
 *   }),
 * };
 * ```
 *
 * @section Driving Effect AI through the gateway
 * @example `aiGateway.model(...)` -> Effect AI `LanguageModel`
 * `model(options)` produces a `Layer<LanguageModel, never,
 * RuntimeContext>` that translates `LanguageModel.generateText` /
 * `streamText` calls (including tool calls and structured outputs)
 * into `ai.run(...)` against the bound Workers AI model, routed
 * through the gateway.
 * ```typescript
 * const aiGateway = yield* Cloudflare.AiGatewayBinding.bind(gateway);
 *
 * const languageModel = aiGateway.model({
 *   client: aiGateway,
 *   model: "@cf/meta/llama-3.1-8b-instruct",
 *   parameters: { temperature: 0.7, maxTokens: 1024 },
 * });
 *
 * const response = yield* AiLanguageModel.generateText({ prompt }).pipe(
 *   Effect.provide(languageModel),
 * );
 * ```
 *
 * Provide {@link AiGatewayBindingLive} in the worker's runtime layer
 * to resolve the underlying Cloudflare AI binding at request time.
 */
export class AiGatewayBinding extends Binding.Service<
  AiGatewayBinding,
  (gateway: AiGatewayResource) => Effect.Effect<AiGatewayClient>
>()("Cloudflare.AiGateway.Binding") {}

/**
 * Runtime layer for {@link AiGatewayBinding}.
 */
export const AiGatewayBindingLive = Layer.effect(
  AiGatewayBinding,
  Effect.gen(function* () {
    const Policy = yield* AiGatewayBindingPolicy;
    const env = yield* WorkerEnvironment;

    return Effect.fn(function* (gateway: AiGatewayResource) {
      yield* Policy(gateway);
      const gatewayIdAccessor = yield* gateway.gatewayId;
      const ai = Effect.sync(
        () => (env as Record<string, Ai>)[gateway.LogicalId]!,
      );
      const runtimeGateway = yield* Effect.zip(ai, gatewayIdAccessor).pipe(
        Effect.map(([ai, gatewayId]) => ai.gateway(gatewayId)),
        Effect.cached,
      );

      const use = <T>(
        fn: (gateway: AiGateway) => Promise<T>,
      ): Effect.Effect<T, AiGatewayError> =>
        runtimeGateway.pipe(
          Effect.flatMap((gateway) => tryPromise(() => fn(gateway))),
        );

      return {
        raw: ai,
        gateway: runtimeGateway,
        id: gatewayIdAccessor,
        patchLog: (logId, data) =>
          use((gateway) => gateway.patchLog(logId, data)),
        getLog: (logId) => use((gateway) => gateway.getLog(logId)),
        getUrl: (provider) => use((gateway) => gateway.getUrl(provider)),
        run: (data, options) => use((gateway) => gateway.run(data, options)),
        model: (options) => makeLanguageModelLayer(options),
      } satisfies AiGatewayClient;
    });
  }),
);

/**
 * Deploy-time policy service that attaches an AI binding to Workers.
 */
export class AiGatewayBindingPolicy extends Binding.Policy<
  AiGatewayBindingPolicy,
  (gateway: AiGatewayResource) => Effect.Effect<void>
>()("Cloudflare.AiGateway.Binding") {}

/**
 * Live deploy-time policy layer for {@link AiGatewayBindingPolicy}.
 */
export const AiGatewayBindingPolicyLive = AiGatewayBindingPolicy.layer.succeed(
  Effect.fn(function* (host: ResourceLike, gateway: AiGatewayResource) {
    if (isWorker(host)) {
      yield* host.bind(gateway.LogicalId, {
        bindings: [
          {
            type: "ai",
            name: gateway.LogicalId,
          },
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`AiGatewayBinding does not support runtime '${host.Type}'`),
      );
    }
  }),
);

const tryPromise = <T>(
  fn: () => Promise<T>,
): Effect.Effect<T, AiGatewayError> =>
  Effect.tryPromise({
    try: fn,
    catch: (error) =>
      new AiGatewayError({
        message:
          error instanceof Error
            ? error.message
            : "Unknown AI Gateway runtime error",
        cause: error,
      }),
  });
