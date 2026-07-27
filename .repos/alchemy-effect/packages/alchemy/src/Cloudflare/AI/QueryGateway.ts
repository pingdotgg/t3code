/// <reference types="@cloudflare/workers-types" />

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { LanguageModel } from "effect/unstable/ai/LanguageModel";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Gateway as GatewayResource } from "./Gateway.ts";
import { type LanguageModelOptions } from "./LanguageModel.ts";

/**
 * Binding service that turns a {@link Gateway} resource
 * into a typed {@link QueryGatewayClient} for Worker runtime code. Wraps
 * the Cloudflare.AI. Gateway runtime binding so each operation returns
 * an Effect tagged with {@link GatewayError}, exposes the raw
 * Workers AI handle for `ai.run(...)`, and provides a `model(options)`
 * factory that produces an `effect/unstable/ai` `LanguageModel`
 * `Layer`.
 *
 * Bind a {@link Gateway} to a Worker and obtain the
 * Effect-native AI Gateway client (`run`, `getUrl`, `model`, …).
 *
 * `QueryGateway` is a single identifier that is simultaneously the binding's
 * Context tag, its type, and the callable —
 * `yield* Cloudflare.AI.QueryGateway(gateway)`.
 *
 * @binding
 * @product AI Gateway
 * @category AI
 *
 * @section Calling AI Gateway
 * @example Run through a gateway
 * Bind the gateway during the Worker's init phase, then use `run` or
 * `getUrl` from request handlers.
 * ```typescript
 * const aiGateway = yield* Cloudflare.AI.QueryGateway(gateway);
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
 * const aiGateway = yield* Cloudflare.AI.QueryGateway(gateway);
 *
 * const languageModel = aiGateway.model({
 *   model: "@cf/meta/llama-3.1-8b-instruct",
 *   parameters: { temperature: 0.7, maxTokens: 1024 },
 * });
 *
 * const response = yield* LanguageModel.generateText({ prompt }).pipe(
 *   Effect.provide(languageModel),
 * );
 * ```
 *
 * Provide {@link QueryGatewayBinding} in the worker's runtime layer
 * to resolve the underlying Cloudflare.AI. binding at request time.
 */
export interface QueryGateway extends Binding.Service<
  QueryGateway,
  "Cloudflare.AI.QueryGateway",
  (gateway: GatewayResource) => Effect.Effect<QueryGatewayClient>
> {}

export const QueryGateway = Binding.Service<QueryGateway>(
  "Cloudflare.AI.QueryGateway",
);

// Error raised by AI Gateway runtime operations.
export class GatewayError extends Data.TaggedError("AiGatewayError")<{
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
 * Effect-native client for a Cloudflare.AI. Gateway Worker binding.
 *
 * Wraps the runtime {@link Gateway} binding so each operation returns an
 * Effect tagged with {@link GatewayError}. Use
 * `Cloudflare.AI.QueryGateway(gateway)` inside a Worker's init phase.
 */
export interface QueryGatewayClient {
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
  ): Effect.Effect<void, GatewayError, RuntimeContext>;
  /**
   * Read an AI Gateway log entry by ID.
   */
  getLog(
    logId: string,
  ): Effect.Effect<AiGatewayLog, GatewayError, RuntimeContext>;
  /**
   * Build a provider URL routed through this gateway.
   */
  getUrl(
    provider?: Parameters<AiGateway["getUrl"]>[0],
  ): Effect.Effect<string, GatewayError, RuntimeContext>;
  /**
   * Run an AI Gateway request through the Cloudflare runtime binding.
   */
  run(
    data: Parameters<AiGateway["run"]>[0],
    options?: Parameters<AiGateway["run"]>[1],
  ): Effect.Effect<Response, GatewayError, RuntimeContext>;

  model(
    options: Omit<LanguageModelOptions, "client">,
  ): Layer.Layer<LanguageModel, never, RuntimeContext>;
}
