import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ServerProvider,
  TextGenerationError,
  type ModelEvaluationVerdict,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import {
  decodeJsonReply,
  fromRunner,
} from "@t3tools/provider-core/server/textGenerationOperations";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";
import * as TextGenerators from "./TextGenerators.ts";

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
  runner: TextGenerators.TextGenerators["Service"]["runner"] = () => Effect.undefined,
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
          Layer.mock(TextGenerators.TextGenerators)({ runner }),
          ProviderInstallationGate.layer,
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
    evidence: [{ ref: "E1", kind: "assistant" as const, text: "The API was preserved." }],
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
  rationale: { text: "The reply addresses the request.", citations: ["U1", "E1"] },
  strengths: [],
  weaknesses: [],
  promptAdvice: [],
};

it.effect.each(["valid verdict", "extra verdict field", "turned off"] as const)(
  "judges only with the selected model API (%s)",
  (state) =>
    Effect.gen(function* () {
      const modelSelection = {
        instanceId: ProviderInstanceId.make("textgen-local"),
        model: "chosen-api-model",
      };
      const generateModelEvaluation = vi.fn(() => Effect.succeed(evaluationVerdict));
      const test = make(
        {
          ...fromRunner("Fixture", () => Effect.die("Unexpected agent generation")),
          supportedOperations: ["generateModelEvaluation"],
          generateModelEvaluation,
        },
        providerSnapshot,
        true,
        (instanceId) =>
          Effect.succeed(
            instanceId === modelSelection.instanceId
              ? (request) => {
                  expect(request.modelSelection).toEqual(modelSelection);
                  expect(request.prompt).toContain(evaluationInput.packet.request.text);
                  return state === "turned off"
                    ? Effect.fail(
                        new TextGenerationError({
                          operation: request.operation,
                          detail: "Model API is off.",
                        }),
                      )
                    : decodeJsonReply(
                        request,
                        "Model API",
                        JSON.stringify(
                          state === "valid verdict"
                            ? evaluationVerdict
                            : { ...evaluationVerdict, extra: true },
                        ),
                      );
                }
              : undefined,
          ),
      );
      const service = yield* test.service;
      const result = yield* service
        .generateModelEvaluation({ ...evaluationInput, modelSelection })
        .pipe(Effect.result);
      if (state === "valid verdict") {
        expect(result).toEqual(Result.succeed(evaluationVerdict));
      } else {
        expect(result._tag).toBe("Failure");
      }
      expect(generateModelEvaluation).not.toHaveBeenCalled();
      expect(test.getInstance).not.toHaveBeenCalled();
    }),
);

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

it.effect.each([undefined, "2999-01-01T00:00:00.000Z", "1970-01-01T00:00:00.000Z"])(
  "avoids automatic memory calls until an exhausted allowance resets (%s)",
  (reset) =>
    Effect.gen(function* () {
      const generateKnowledgeCandidates = vi.fn(() => Effect.succeed({ candidates: [] }));
      const test = make(
        {
          ...fromRunner("Fixture", () => Effect.die("Unexpected generation operation")),
          supportedOperations: ["generateKnowledgeCandidates"],
          generateKnowledgeCandidates,
        },
        {
          ...providerSnapshot,
          usageLimits: {
            checkedAt: "1970-01-01T00:00:00.000Z",
            windows: [
              {
                id: "session",
                kind: "session",
                label: "Session",
                usedPercent: 100,
                resetsAt: reset,
              },
            ],
          },
        },
      );
      const service = yield* test.service;
      const result = yield* service
        .generateKnowledgeCandidates({ ...input, runOutcome: "completed" })
        .pipe(Effect.result);
      if (reset === "1970-01-01T00:00:00.000Z") {
        expect(generateKnowledgeCandidates).toHaveBeenCalledOnce();
      } else {
        expect(result._tag).toBe("Failure");
        expect(generateKnowledgeCandidates).not.toHaveBeenCalled();
      }
    }),
);
