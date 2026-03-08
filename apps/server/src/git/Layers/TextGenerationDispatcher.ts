/**
 * TextGenerationDispatcher - Routes text generation to the correct provider CLI.
 *
 * Uses the `provider` hint on each input to pick the right backend.
 * Falls back to whichever CLI is available when no hint is given.
 *
 * Both backends are always loaded (if their modules exist). The actual CLI
 * availability is validated at call time when the process is spawned, avoiding
 * false negatives from one-shot startup checks that may run before the user's
 * PATH is fully resolved.
 */
import type { ProviderKind } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { TextGenerationError } from "../Errors.ts";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";

const makeTextGenerationDispatcher = Effect.gen(function* () {
  let claudeBackend: TextGenerationShape | null = null;
  let codexBackend: TextGenerationShape | null = null;

  const claudeResult = yield* Effect.tryPromise({
    try: () => import("./ClaudeTextGeneration.ts"),
    catch: () =>
      new TextGenerationError({
        operation: "init",
        detail: "Failed to load ClaudeTextGeneration module.",
      }),
  }).pipe(
    Effect.flatMap((mod) => mod.makeClaudeTextGeneration),
    Effect.option,
  );
  if (claudeResult._tag === "Some") {
    claudeBackend = claudeResult.value;
  }

  const codexResult = yield* Effect.tryPromise({
    try: () => import("./CodexTextGeneration.ts"),
    catch: () =>
      new TextGenerationError({
        operation: "init",
        detail: "Failed to load CodexTextGeneration module.",
      }),
  }).pipe(
    Effect.flatMap((mod) => mod.makeCodexTextGeneration),
    Effect.option,
  );
  if (codexResult._tag === "Some") {
    codexBackend = codexResult.value;
  }

  const fallbackBackend = claudeBackend ?? codexBackend;

  function resolve(provider: ProviderKind | undefined): TextGenerationShape {
    if (provider === "claudeCode" && claudeBackend) return claudeBackend;
    if (provider === "codex" && codexBackend) return codexBackend;
    if (fallbackBackend) return fallbackBackend;
    const fail = (operation: string) =>
      Effect.fail(
        new TextGenerationError({
          operation,
          detail:
            "No AI CLI is available for text generation. Install either Claude CLI (`claude`) or Codex CLI (`codex`).",
        }),
      );
    return {
      generateCommitMessage: () => fail("generateCommitMessage"),
      generatePrContent: () => fail("generatePrContent"),
      generateBranchName: () => fail("generateBranchName"),
    };
  }

  return {
    generateCommitMessage: (input) => resolve(input.provider).generateCommitMessage(input),
    generatePrContent: (input) => resolve(input.provider).generatePrContent(input),
    generateBranchName: (input) => resolve(input.provider).generateBranchName(input),
  } satisfies TextGenerationShape;
});

export const TextGenerationDispatcherLive = Layer.effect(
  TextGeneration,
  makeTextGenerationDispatcher,
);
