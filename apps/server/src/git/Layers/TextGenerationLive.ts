/**
 * TextGenerationLive — registry-backed implementation of the `TextGeneration`
 * service tag.
 *
 * The `TextGeneration` tag is kept as a thin facade over
 * `ProviderInstanceRegistry`. Every op pulls `modelSelection.instanceId`,
 * looks up the matching `ProviderInstance`, and delegates to that instance's
 * own `textGeneration` closure (built by its driver's `create()`).
 *
 * There is deliberately no per-driver dispatch here — the registry already
 * knows which driver backs each instance, and each `ProviderInstance`
 * carries the fully-bound `TextGenerationShape` produced by its driver.
 * That means:
 *
 *   - Multiple instances of the same driver (e.g. `codex_personal`,
 *     `codex_work`) each get their own text-generation closure bound to
 *     their own settings — the routing is by instance, not by driver.
 *   - Unknown or disabled instances surface a `TextGenerationError` with
 *     the missing `instanceId`, instead of silently falling back to a
 *     default.
 *
 * This replaces the old `RoutingTextGenerationLive`, which tried to route
 * by driver-kind and misused `modelSelection.instanceId` as a driver-id
 * literal.
 *
 * @module git/Layers/TextGenerationLive
 */
import { Effect, Layer } from "effect";

import { TextGenerationError } from "@t3tools/contracts";
import type { ProviderInstanceId } from "@t3tools/contracts";

import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { TextGeneration, type TextGenerationShape } from "../Services/TextGeneration.ts";

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const resolveInstance = (
  registry: ProviderInstanceRegistryShape,
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

/**
 * Build a `TextGenerationShape` that routes every call through the
 * registry. Exposed separately from the Layer so tests can construct it
 * against a stub registry without layering gymnastics.
 */
export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistryShape,
): TextGenerationShape => ({
  generateCommitMessage: (input) =>
    resolveInstance(registry, "generateCommitMessage", input.modelSelection.instanceId).pipe(
      Effect.flatMap((tg) => tg.generateCommitMessage(input)),
    ),
  generatePrContent: (input) =>
    resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
      Effect.flatMap((tg) => tg.generatePrContent(input)),
    ),
  generateBranchName: (input) =>
    resolveInstance(registry, "generateBranchName", input.modelSelection.instanceId).pipe(
      Effect.flatMap((tg) => tg.generateBranchName(input)),
    ),
  generateThreadTitle: (input) =>
    resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
      Effect.flatMap((tg) => tg.generateThreadTitle(input)),
    ),
});

/**
 * `TextGeneration` Layer wired to the `ProviderInstanceRegistry`. The rest
 * of the server keeps using `yield* TextGeneration` — only the underlying
 * wiring changed from kind-based routing to instance-based routing.
 */
export const TextGenerationLive = Layer.effect(
  TextGeneration,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry;
    return makeTextGenerationFromRegistry(registry);
  }),
);
