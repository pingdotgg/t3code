import type { ModelSelection, OllamaSettings } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
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
import {
  ollamaApiUrl,
  type OllamaFetch,
  OLLAMA_API_KEY_ENV,
} from "../provider/Layers/OllamaProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const OLLAMA_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);

export function makeOllamaTextGeneration(
  settings: OllamaSettings,
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: OllamaFetch = fetch,
): TextGeneration.TextGeneration["Service"] {
  const call = <S extends Schema.Top>(
    operation: string,
    cwd: string,
    prompt: string,
    selection: ModelSelection,
    outputSchema: S,
  ): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.tryPromise({
      try: async (signal) => {
        const key = settings.apiKey.trim() || environment[OLLAMA_API_KEY_ENV]?.trim();
        const response = await fetchImpl(ollamaApiUrl(settings.host, "/chat"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(key ? { authorization: `Bearer ${key}` } : {}),
          },
          signal,
          body: encodeJson({
            model: selection.model || settings.defaultModel || "llama3.2",
            stream: false,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { message?: { content?: unknown } };
        const content =
          typeof body.message?.content === "string" ? body.message.content.trim() : "";
        if (!content) throw new Error("Ollama returned empty output");
        return extractJsonObject(content);
      },
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: `Ollama text generation failed for ${cwd}.`,
          cause,
        }),
    }).pipe(
      Effect.timeoutOption(OLLAMA_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: `Ollama text generation timed out for ${cwd}.`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.flatMap((output) =>
        Schema.decodeEffect(Schema.fromJsonString(outputSchema))(output).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation,
                detail: "Ollama returned invalid structured output.",
                cause,
              }),
          ),
        ),
      ),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: `Ollama text generation failed for ${cwd}.`,
              cause,
            }),
      ),
    );
  return {
    generateCommitMessage: (input) => {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      return Effect.map(
        call("generateCommitMessage", input.cwd, prompt, input.modelSelection, outputSchema),
        (value) => ({
          subject: sanitizeCommitSubject(value.subject),
          body: value.body.trim(),
          ...("branch" in value && typeof value.branch === "string"
            ? { branch: sanitizeFeatureBranchName(value.branch) }
            : {}),
        }),
      );
    },
    generatePrContent: (input) => {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      return Effect.map(
        call("generatePrContent", input.cwd, prompt, input.modelSelection, outputSchema),
        (value) => ({
          title: sanitizePrTitle(value.title),
          body: value.body.trim(),
        }),
      );
    },
    generateBranchName: (input) => {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
        policy: input.policy,
      });
      return Effect.map(
        call("generateBranchName", input.cwd, prompt, input.modelSelection, outputSchema),
        (value) => ({ branch: sanitizeBranchFragment(value.branch) }),
      );
    },
    generateThreadTitle: (input) => {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      return Effect.map(
        call("generateThreadTitle", input.cwd, prompt, input.modelSelection, outputSchema),
        (value) => ({ title: sanitizeThreadTitle(value.title) }),
      );
    },
  } satisfies TextGeneration.TextGeneration["Service"];
}
