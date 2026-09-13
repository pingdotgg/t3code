import type { ModelSelection, OllamaSettings } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export function makeOllamaTextGeneration(
  settings: OllamaSettings,
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: OllamaFetch = fetch,
): TextGeneration.TextGeneration["Service"] {
  const call = (operation: string, cwd: string, prompt: string, selection: ModelSelection) =>
    Effect.tryPromise({
      try: async () => {
        const key = settings.apiKey.trim() || environment[OLLAMA_API_KEY_ENV]?.trim();
        const response = await fetchImpl(ollamaApiUrl(settings.host, "/chat"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(key ? { authorization: `Bearer ${key}` } : {}),
          },
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
        return decodeJson(extractJsonObject(content)) as Record<string, unknown>;
      },
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: `Ollama text generation failed for ${cwd}.`,
          cause,
        }),
    });
  return {
    generateCommitMessage: (input) =>
      Effect.map(
        call(
          "generateCommitMessage",
          input.cwd,
          buildCommitMessagePrompt({
            branch: input.branch,
            stagedSummary: input.stagedSummary,
            stagedPatch: input.stagedPatch,
            includeBranch: input.includeBranch === true,
            policy: input.policy,
          }).prompt,
          input.modelSelection,
        ),
        (value) => ({
          subject: sanitizeCommitSubject(String(value.subject ?? "")),
          body: String(value.body ?? "").trim(),
          ...(typeof value.branch === "string" ? { branch: value.branch } : {}),
        }),
      ),
    generatePrContent: (input) =>
      Effect.map(
        call(
          "generatePrContent",
          input.cwd,
          buildPrContentPrompt({
            baseBranch: input.baseBranch,
            headBranch: input.headBranch,
            commitSummary: input.commitSummary,
            diffSummary: input.diffSummary,
            diffPatch: input.diffPatch,
            policy: input.policy,
            changeRequestTemplate: input.changeRequestTemplate,
          }).prompt,
          input.modelSelection,
        ),
        (value) => ({
          title: sanitizePrTitle(String(value.title ?? "")),
          body: String(value.body ?? "").trim(),
        }),
      ),
    generateBranchName: (input) =>
      Effect.map(
        call(
          "generateBranchName",
          input.cwd,
          buildBranchNamePrompt({ message: input.message, attachments: input.attachments }).prompt,
          input.modelSelection,
        ),
        (value) => ({ branch: String(value.branch ?? "").trim() }),
      ),
    generateThreadTitle: (input) =>
      Effect.map(
        call(
          "generateThreadTitle",
          input.cwd,
          buildThreadTitlePrompt({
            message: input.message,
            previousTitle: input.previousTitle,
            attachments: input.attachments,
          }).prompt,
          input.modelSelection,
        ),
        (value) => ({ title: sanitizeThreadTitle(String(value.title ?? "")) }),
      ),
  } satisfies TextGeneration.TextGeneration["Service"];
}
