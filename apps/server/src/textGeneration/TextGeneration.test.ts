import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ServerProvider,
  TextGenerationError,
  type ModelEvaluationVerdict,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { fromRunner } from "@t3tools/provider-core/server/textGenerationOperations";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

const selected = ProviderInstanceId.make("selected");
const decodeProvider = Schema.decodeSync(ServerProvider);
const providerSnapshot = decodeProvider({
  instanceId: selected,
  driver: "claudeAgent",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-03T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  textGenerationOperations: ["generateModelEvaluation"],
});
const input = {
  cwd: "/project",
  messages: [{ ref: "M1", role: "user" as const, text: "Keep the existing API." }],
  modelSelection: { instanceId: selected, model: "chosen-model" },
};

const make = (
  textGeneration: ProviderInstance["textGeneration"],
  snapshot: ServerProvider = providerSnapshot,
  enabled = true,
) => {
  const getInstance = vi.fn((instanceId: typeof selected) =>
    Effect.succeed(
      instanceId === selected
        ? ({
            instanceId,
            displayName: "Selected provider",
            enabled,
            snapshot: { getSnapshot: Effect.succeed(snapshot) },
            textGeneration,
          } as ProviderInstance)
        : undefined,
    ),
  );
  return {
    getInstance,
    service: TextGeneration.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({ getInstance }),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => undefined,
          }),
          ServerSettings.layerTest({}),
        ),
      ),
    ),
  };
};

it.effect("rejects an unsupported selected operation before invoking a provider", () =>
  Effect.gen(function* () {
    const generateConversationSummary = vi.fn(() => Effect.succeed({ statements: [] }));
    const test = make({
      ...fromRunner("Fixture", () => Effect.die("Unexpected generation operation")),
      supportedOperations: ["generateThreadTitle"],
      generateConversationSummary,
    });
    const service = yield* test.service;
    const failure = yield* service.generateConversationSummary(input).pipe(Effect.flip);
    expect(failure).toBeInstanceOf(TextGenerationError);
    expect(failure.operation).toBe("generateConversationSummary");
    expect(failure.detail).toContain("does not support");
    expect(generateConversationSummary).not.toHaveBeenCalled();
    expect(test.getInstance.mock.calls).toEqual([[selected]]);
  }),
);

it.effect("uses the exact selected instance and model for a supported operation", () =>
  Effect.gen(function* () {
    const result = { statements: [{ text: "Keep the existing API.", citations: ["M1"] }] };
    const generateConversationSummary = vi.fn(() => Effect.succeed(result));
    const test = make({
      ...fromRunner("Fixture", () => Effect.die("Unexpected generation operation")),
      supportedOperations: ["generateConversationSummary"],
      generateConversationSummary,
    });
    const service = yield* test.service;
    expect(yield* service.generateConversationSummary(input)).toEqual(result);
    expect(generateConversationSummary).toHaveBeenCalledExactlyOnceWith(input);
    expect(test.getInstance.mock.calls).toEqual([[selected]]);
  }),
);

const evaluationInput = {
  cwd: "/empty-evaluator-directory",
  modelSelection: { instanceId: selected, model: "chosen-model" },
  packet: {
    scope: "turn" as const,
    runOutcome: "completed" as const,
    request: { ref: "U1" as const, text: "Preserve the API." },
    context: [],
    evidence: [{ ref: "A1", kind: "assistant" as const, text: "The API was preserved." }],
    truncated: false,
    omittedItems: 0,
    missingArtifacts: true,
  },
};

const evaluationVerdict: ModelEvaluationVerdict = {
  outcome: "scored",
  taskCategory: "coding",
  scores: { taskCompletion: 3, correctness: null, instructionFollowing: 3, verification: null },
  confidence: "low",
  rationale: { text: "The reply addresses the request.", citations: ["U1", "A1"] },
  strengths: [],
  weaknesses: [],
  promptAdvice: [],
};

it.effect.each([
  "disabled-instance",
  "disabled-snapshot",
  "not-installed",
  "unauthenticated",
  "unavailable",
  "no-text-generation",
  "operation-not-advertised",
] as const)("does not invoke a selected evaluator that is %s", (state) =>
  Effect.gen(function* () {
    const generateModelEvaluation = vi.fn(() => Effect.succeed(evaluationVerdict));
    const snapshot: ServerProvider = {
      ...providerSnapshot,
      ...(state === "disabled-snapshot" ? { enabled: false } : {}),
      ...(state === "not-installed" ? { installed: false } : {}),
      ...(state === "unauthenticated" ? { auth: { status: "unauthenticated" as const } } : {}),
      ...(state === "unavailable" ? { availability: "unavailable" as const } : {}),
      ...(state === "no-text-generation" ? { supportsTextGeneration: false } : {}),
      ...(state === "operation-not-advertised" ? { textGenerationOperations: [] } : {}),
    };
    const test = make(
      {
        ...fromRunner("Fixture", () => Effect.die("Unexpected generation operation")),
        supportedOperations: ["generateModelEvaluation"],
        generateModelEvaluation,
      },
      snapshot,
      state !== "disabled-instance",
    );
    const service = yield* test.service;
    const failure = yield* service.generateModelEvaluation(evaluationInput).pipe(Effect.flip);
    expect(failure.operation).toBe("generateModelEvaluation");
    expect(failure.detail).toContain("selected evaluator is unavailable");
    expect(generateModelEvaluation).not.toHaveBeenCalled();
    expect(test.getInstance.mock.calls).toEqual([[selected]]);
  }),
);

it.effect(
  "invokes the available evaluator with the exact selected instance, model, and packet",
  () =>
    Effect.gen(function* () {
      const generateModelEvaluation = vi.fn(() => Effect.succeed(evaluationVerdict));
      const test = make({
        ...fromRunner("Fixture", () => Effect.die("Unexpected generation operation")),
        supportedOperations: ["generateModelEvaluation"],
        generateModelEvaluation,
      });
      const service = yield* test.service;
      expect(yield* service.generateModelEvaluation(evaluationInput)).toEqual(evaluationVerdict);
      expect(generateModelEvaluation).toHaveBeenCalledExactlyOnceWith(evaluationInput);
      expect(test.getInstance.mock.calls).toEqual([[selected]]);
    }),
);
