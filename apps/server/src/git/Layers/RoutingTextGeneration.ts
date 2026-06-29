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
import { Effect, Layer, Context } from "effect";

import { TextGeneration, type TextGenerationShape } from "../Services/TextGeneration.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { ClaudeTextGenerationLive } from "./ClaudeTextGeneration.ts";
import { CursorTextGenerationLive } from "./CursorTextGeneration.ts";
import { GrokTextGenerationLive } from "./GrokTextGeneration.ts";
import { OpenCodeTextGenerationLive } from "./OpenCodeTextGeneration.ts";

// ---------------------------------------------------------------------------
// Internal service tags so both concrete layers can coexist.
// ---------------------------------------------------------------------------

class CodexTextGen extends Context.Service<CodexTextGen, TextGenerationShape>()(
  "forma/git/Layers/RoutingTextGeneration/CodexTextGen",
) {}

class ClaudeTextGen extends Context.Service<ClaudeTextGen, TextGenerationShape>()(
  "forma/git/Layers/RoutingTextGeneration/ClaudeTextGen",
) {}

class CursorTextGen extends Context.Service<CursorTextGen, TextGenerationShape>()(
  "forma/git/Layers/RoutingTextGeneration/CursorTextGen",
) {}

class GrokTextGen extends Context.Service<GrokTextGen, TextGenerationShape>()(
  "forma/git/Layers/RoutingTextGeneration/GrokTextGen",
) {}

class OpenCodeTextGen extends Context.Service<OpenCodeTextGen, TextGenerationShape>()(
  "forma/git/Layers/RoutingTextGeneration/OpenCodeTextGen",
) {}

// ---------------------------------------------------------------------------
// Routing implementation
// ---------------------------------------------------------------------------

const makeRoutingTextGeneration = Effect.gen(function* () {
  const byProvider = {
    codex: yield* CodexTextGen,
    claudeAgent: yield* ClaudeTextGen,
    cursor: yield* CursorTextGen,
    grok: yield* GrokTextGen,
    opencode: yield* OpenCodeTextGen,
  };

  return {
    generateCommitMessage: (input) =>
      byProvider[input.modelSelection.provider].generateCommitMessage(input),
    generatePrContent: (input) =>
      byProvider[input.modelSelection.provider].generatePrContent(input),
    generateBranchName: (input) =>
      byProvider[input.modelSelection.provider].generateBranchName(input),
    generateThreadTitle: (input) =>
      byProvider[input.modelSelection.provider].generateThreadTitle(input),
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

const InternalGrokLayer = Layer.effect(
  GrokTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(GrokTextGenerationLive));

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
  Layer.provide(InternalGrokLayer),
  Layer.provide(InternalOpenCodeLayer),
);
