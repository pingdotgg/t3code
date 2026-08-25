/**
 * OllamaTextGeneration — text generation via the Ollama REST API.
 *
 * Uses Ollama's `/api/chat` endpoint with `format: "json"` for structured
 * output. Ollama models that support the JSON format will return valid JSON
 * matching the provided schema; models without JSON support will return
 * free text that we attempt to extract a JSON object from.
 *
 * @module textGeneration/OllamaTextGeneration
 */
import { type OllamaSettings, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

const OLLAMA_TIMEOUT_MS = 60_000;

function resolveOllamaServerUrl(settings: OllamaSettings): string {
  const trimmed = settings.serverUrl.trim();
  return trimmed.length > 0 ? trimmed : "http://127.0.0.1:11434";
}

function resolveOllamaModel(selection: ModelSelection): string {
  const trimmed = selection.model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "llama3.2";
}

export const makeOllamaTextGeneration = Effect.fn("makeOllamaTextGeneration")(function* (
  ollamaSettings: OllamaSettings,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const serverUrl = resolveOllamaServerUrl(ollamaSettings);

  const runOllamaJson = <S extends Schema.Top>({
    operation,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const model = resolveOllamaModel(modelSelection);

      const requestBody = {
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        format: "json",
      };

      const response = yield* Effect.gen(function* () {
        const request = HttpClientRequest.post(`${serverUrl}/api/chat`).pipe(
          HttpClientRequest.setHeader("Content-Type", "application/json"),
          HttpClientRequest.bodyJson(requestBody),
        );
        return yield* httpClient.execute(request).pipe(
          Effect.timeoutOption(OLLAMA_TIMEOUT_MS),
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: `Failed to connect to Ollama server at ${serverUrl}.`,
                cause,
              }),
          ),
        );
      });

      if (response._tag === "None") {
        return yield* new TextGenerationError({
          operation,
          detail: "Ollama request timed out.",
        });
      }

      const httpResponse = response.value;
      if (httpResponse.status !== 200) {
        const errorBody = yield* HttpClientResponse.bodyToString(httpResponse).pipe(
          Effect.orElseSucceed(() => ""),
        );
        return yield* new TextGenerationError({
          operation,
          detail: `Ollama server returned HTTP ${httpResponse.status}: ${errorBody.slice(0, 500)}`,
        });
      }

      const bodyText = yield* HttpClientResponse.bodyToString(httpResponse);
      let parsed: { message?: { content?: string }; done?: boolean };
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        return yield* new TextGenerationError({
          operation,
          detail: "Ollama server returned an invalid JSON response.",
        });
      }

      const content = parsed.message?.content?.trim();
      if (!content) {
        return yield* new TextGenerationError({
          operation,
          detail: "Ollama returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(content)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Ollama returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof TextGenerationError
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Ollama text generation failed.",
              cause,
            }),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("OllamaTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
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

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("OllamaTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

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

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("OllamaTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

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

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("OllamaTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });

      const generated = yield* runOllamaJson({
        operation: "generateThreadTitle",
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});