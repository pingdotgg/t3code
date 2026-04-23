/**
 * RoutingTextGeneration – Dispatches text generation requests to either the
 * Codex CLI or Claude CLI implementation based on the provider in each
 * request input.
 *
 * When `modelSelection.provider` is `"claudeAgent"` the request is forwarded to
 * the Claude layer; for any other value (including the default `undefined`) it
 * falls through to the Codex layer.
 *
 * @module RoutingTextGeneration
 */
import { Context, Effect, Layer } from "effect";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type ModelSelection,
} from "@marcode/contracts";

import type { TextGenerationError } from "@marcode/contracts";
import {
  TextGeneration,
  type TextGenerationProvider,
  type TextGenerationShape,
} from "../Services/TextGeneration.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { ClaudeTextGenerationLive } from "./ClaudeTextGeneration.ts";
import { CursorTextGenerationLive } from "./CursorTextGeneration.ts";
import { OpenCodeTextGenerationLive } from "./OpenCodeTextGeneration.ts";

// ---------------------------------------------------------------------------
// Internal service tags so both concrete layers can coexist.
// ---------------------------------------------------------------------------

class CodexTextGen extends Context.Service<CodexTextGen, TextGenerationShape>()(
  "marcode/git/Layers/RoutingTextGeneration/CodexTextGen",
) {}

class ClaudeTextGen extends Context.Service<ClaudeTextGen, TextGenerationShape>()(
  "marcode/git/Layers/RoutingTextGeneration/ClaudeTextGen",
) {}

class CursorTextGen extends Context.Service<CursorTextGen, TextGenerationShape>()(
  "marcode/git/Layers/RoutingTextGeneration/CursorTextGen",
) {}

class OpenCodeTextGen extends Context.Service<OpenCodeTextGen, TextGenerationShape>()(
  "marcode/git/Layers/RoutingTextGeneration/OpenCodeTextGen",
) {}

// ---------------------------------------------------------------------------
// Routing implementation
// ---------------------------------------------------------------------------

const alternateProvider = (provider: TextGenerationProvider): TextGenerationProvider =>
  provider === "claudeAgent" ? "codex" : "claudeAgent";

const isProviderNotInstalled = (err: TextGenerationError): boolean =>
  err.detail.includes("not available on PATH");

const makeRoutingTextGeneration = Effect.gen(function* () {
  const codex = yield* CodexTextGen;
  const claude = yield* ClaudeTextGen;
  const cursor = yield* CursorTextGen;
  const openCode = yield* OpenCodeTextGen;

  const route = (provider?: TextGenerationProvider): TextGenerationShape =>
    provider === "claudeAgent"
      ? claude
      : provider === "opencode"
        ? openCode
        : provider === "cursor"
          ? cursor
          : codex;

  const withFallback = <I extends { modelSelection: ModelSelection }, R>(
    method: (impl: TextGenerationShape) => (input: I) => Effect.Effect<R, TextGenerationError>,
    input: I,
  ): Effect.Effect<R, TextGenerationError> => {
    const primary = input.modelSelection.provider as TextGenerationProvider;
    return method(route(primary))(input).pipe(
      Effect.catchIf(isProviderNotInstalled, () => {
        const alt = alternateProvider(primary);
        return method(route(alt))({
          ...input,
          modelSelection: {
            provider: alt,
            model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[alt],
          } as ModelSelection,
        });
      }),
    );
  };

  return {
    generateCommitMessage: (input) => withFallback((impl) => impl.generateCommitMessage, input),
    generatePrContent: (input) => withFallback((impl) => impl.generatePrContent, input),
    generateBranchName: (input) => withFallback((impl) => impl.generateBranchName, input),
    generateThreadTitle: (input) => withFallback((impl) => impl.generateThreadTitle, input),
  } satisfies TextGenerationShape;
});

const InternalCodexLayer = Layer.effect(
  CodexTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(CodexTextGenerationLive));

const InternalClaudeLayer = Layer.effect(
  ClaudeTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(ClaudeTextGenerationLive));

const InternalCursorLayer = Layer.effect(
  CursorTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(CursorTextGenerationLive));

const InternalOpenCodeLayer = Layer.effect(
  OpenCodeTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(OpenCodeTextGenerationLive));

export const RoutingTextGenerationLive = Layer.effect(
  TextGeneration,
  makeRoutingTextGeneration,
).pipe(
  Layer.provide(InternalCodexLayer),
  Layer.provide(InternalClaudeLayer),
  Layer.provide(InternalCursorLayer),
  Layer.provide(InternalOpenCodeLayer),
);
