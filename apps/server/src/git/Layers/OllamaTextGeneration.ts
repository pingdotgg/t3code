import { Effect, Layer, Schema } from "effect";

import { OllamaModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "../Utils.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { resolveOllamaConnectionForSelection } from "../../provider/ollama/client.ts";

const OLLAMA_TEXT_GENERATION_TIMEOUT_MS = 180_000;

async function runOllamaJsonRequest<T>(input: {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly authMode: "none" | "bearer";
  readonly model: string;
  readonly prompt: string;
  readonly schema: unknown;
}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TEXT_GENERATION_TIMEOUT_MS);
  try {
    const response = await fetch(`${input.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(input.authMode === "bearer" && input.apiKey
          ? { Authorization: `Bearer ${input.apiKey}` }
          : {}),
      },
      body: JSON.stringify({
        model: input.model,
        stream: false,
        format: input.schema,
        messages: [{ role: "user", content: input.prompt }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(body.trim() || `Ollama request failed with HTTP ${response.status}.`);
    }
    const json = (await response.json()) as {
      readonly message?: { readonly content?: string };
    };
    const content = json.message?.content?.trim();
    if (!content) {
      throw new Error("Ollama returned an empty response.");
    }
    return JSON.parse(content) as T;
  } finally {
    clearTimeout(timeout);
  }
}

const makeOllamaTextGeneration = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;

  const runOllamaJson = Effect.fn("runOllamaJson")(function* <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: OllamaModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Failed to load server settings.",
            cause,
          }),
      ),
    );
    const connection = resolveOllamaConnectionForSelection({
      settings,
      ...(input.modelSelection.options ? { modelOptions: input.modelSelection.options } : {}),
    })?.connection;
    if (!connection) {
      return yield* new TextGenerationError({
        operation: input.operation,
        detail: "No Ollama connection is configured.",
      });
    }

    const raw = yield* Effect.tryPromise(() =>
      runOllamaJsonRequest({
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        authMode: connection.authMode,
        model: input.modelSelection.model,
        prompt: input.prompt,
        schema: toJsonSchemaObject(input.outputSchemaJson),
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: cause instanceof Error ? cause.message : "Ollama request failed.",
            cause,
          }),
      ),
    );

    return yield* Schema.decodeEffect(input.outputSchemaJson)(raw).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation: input.operation,
            detail: "Ollama returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "OllamaTextGeneration.generateCommitMessage",
  )(function* (input) {
    if (input.modelSelection.provider !== "ollama") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    const generated = yield* runOllamaJson({
      operation: "generateCommitMessage",
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "OllamaTextGeneration.generatePrContent",
  )(function* (input) {
    if (input.modelSelection.provider !== "ollama") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }
    const { prompt, outputSchema } = buildPrContentPrompt(input);
    const generated = yield* runOllamaJson({
      operation: "generatePrContent",
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "OllamaTextGeneration.generateBranchName",
  )(function* (input) {
    if (input.modelSelection.provider !== "ollama") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }
    const { prompt, outputSchema } = buildBranchNamePrompt(input);
    const generated = yield* runOllamaJson({
      operation: "generateBranchName",
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "OllamaTextGeneration.generateThreadTitle",
  )(function* (input) {
    if (input.modelSelection.provider !== "ollama") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }
    const { prompt, outputSchema } = buildThreadTitlePrompt(input);
    const generated = yield* runOllamaJson({
      operation: "generateThreadTitle",
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const OllamaTextGenerationLive = Layer.effect(TextGeneration, makeOllamaTextGeneration);
