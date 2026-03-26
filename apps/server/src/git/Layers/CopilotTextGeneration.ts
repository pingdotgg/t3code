import { Effect, Layer, Schema } from "effect";

import {
  type CodexReasoningEffort,
  type CopilotModelSelection,
  type ChatAttachment,
} from "@t3tools/contracts";
import {
  approveAll,
  CopilotClient,
  type CopilotClientOptions,
  type SessionEvent,
} from "@github/copilot-sdk";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { ServerConfig } from "../../config.ts";
import {
  loadCopilotSupportedModels,
  materializeCopilotAttachments,
  resolveCopilotRuntimeConfig,
  resolveCopilotSelectedModel,
  selectCopilotReasoningEffort,
  stopCopilotClient,
  validateCopilotReasoningEffort,
} from "../../provider/Layers/copilotSdk.ts";
import { TextGenerationError } from "../Errors.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
} from "../Prompts.ts";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";
import { normalizeCliError, sanitizeCommitSubject, sanitizePrTitle } from "../Utils.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const COPILOT_GIT_TEXT_GENERATION_REASONING_EFFORT = "low" as const;
const COPILOT_TIMEOUT_MS = 180_000;

export interface CopilotTextGenerationLiveOptions {
  readonly clientFactory?: (options: CopilotClientOptions) => CopilotTextGenerationClientHandle;
}

interface CopilotTextGenerationSessionHandle {
  send(options: {
    prompt: string;
    attachments?: Array<{ type: "file"; path: string; displayName?: string }>;
    mode?: "enqueue" | "immediate";
  }): Promise<string>;
  getMessages(): Promise<ReadonlyArray<SessionEvent>>;
  destroy(): Promise<void>;
}

interface CopilotTextGenerationClientHandle {
  start(): Promise<void>;
  stop(): Promise<ReadonlyArray<Error>>;
  listModels(): Promise<ReadonlyArray<import("@github/copilot-sdk").ModelInfo>>;
  createSession(config: {
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
    workingDirectory?: string;
    configDir?: string;
    streaming?: boolean;
    onEvent?: (event: SessionEvent) => void;
    onPermissionRequest?: unknown;
  }): Promise<CopilotTextGenerationSessionHandle>;
}

function buildStrictJsonPrompt(prompt: string): string {
  return `${prompt}\n\nReturn only valid JSON. Do not include markdown fences or explanatory text.`;
}

function findLastAssistantMessage(events: ReadonlyArray<SessionEvent>): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "assistant.message") {
      const content = event.data.content.trim();
      if (content.length > 0) {
        return content;
      }
    }
  }
  return null;
}

function extractJsonCandidates(content: string): string[] {
  const trimmed = content.trim();
  const candidates = new Set<string>();
  if (trimmed.length > 0) {
    candidates.add(trimmed);
  }

  const fencedMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fencedMatch?.[1]) {
    candidates.add(fencedMatch[1].trim());
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.add(trimmed.slice(firstBrace, lastBrace + 1));
  }

  return [...candidates];
}

function decodeStructuredOutput<
  S extends Schema.Top & {
    readonly DecodingServices: never;
  },
>(input: {
  operation: "generateCommitMessage" | "generatePrContent" | "generateBranchName";
  content: string;
  outputSchema: S;
}): Effect.Effect<S["Type"], TextGenerationError> {
  const decode = Schema.decodeUnknownSync(input.outputSchema);

  return Effect.try({
    try: () => {
      for (const candidate of extractJsonCandidates(input.content)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(candidate);
        } catch {
          continue;
        }

        try {
          return decode(parsed);
        } catch {
          continue;
        }
      }

      throw new TextGenerationError({
        operation: input.operation,
        detail: "GitHub Copilot returned invalid structured output.",
      });
    },
    catch: (cause) =>
      Schema.is(TextGenerationError)(cause)
        ? cause
        : new TextGenerationError({
            operation: input.operation,
            detail: "GitHub Copilot returned invalid structured output.",
            cause,
          }),
  });
}

const makeCopilotTextGeneration = (options?: CopilotTextGenerationLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const serverSettingsService = yield* Effect.service(ServerSettingsService);

    const runCopilotJson = <
      S extends Schema.Top & {
        readonly DecodingServices: never;
      },
    >(input: {
      operation: "generateCommitMessage" | "generatePrContent" | "generateBranchName";
      cwd: string;
      prompt: string;
      outputSchema: S;
      modelSelection: CopilotModelSelection;
      attachments?: ReadonlyArray<ChatAttachment>;
    }): Effect.Effect<S["Type"], TextGenerationError> =>
      Effect.gen(function* () {
        const copilotSettings = yield* serverSettingsService.getSettings.pipe(
          Effect.map((settings) => settings.providers.copilot),
          Effect.mapError((cause) =>
            normalizeCliError(
              "copilot",
              input.operation,
              cause,
              "Failed to load GitHub Copilot settings",
            ),
          ),
        );
        const { clientOptions, configDir } = resolveCopilotRuntimeConfig(
          copilotSettings,
          input.cwd,
        );
        return yield* Effect.acquireUseRelease(
          Effect.sync(
            () => options?.clientFactory?.(clientOptions) ?? new CopilotClient(clientOptions),
          ),
          (client) =>
            Effect.gen(function* () {
              const supportedModels = yield* loadCopilotSupportedModels({
                client,
                onStartError: (cause) =>
                  normalizeCliError(
                    "copilot",
                    input.operation,
                    cause,
                    "Failed to start GitHub Copilot client",
                  ),
                onListError: (cause) =>
                  normalizeCliError(
                    "copilot",
                    input.operation,
                    cause,
                    "Failed to load GitHub Copilot model metadata",
                  ),
              });
              const selectedModel = yield* resolveCopilotSelectedModel({
                supportedModels,
                model: input.modelSelection.model,
                onMissingModel: (model) =>
                  new TextGenerationError({
                    operation: input.operation,
                    detail: `GitHub Copilot model '${model}' is not available in the current Copilot runtime.`,
                  }),
              });

              const explicitReasoningEffort = input.modelSelection.options?.reasoningEffort;
              yield* validateCopilotReasoningEffort({
                selectedModel,
                reasoningEffort: explicitReasoningEffort,
                onMissingModel: () =>
                  new TextGenerationError({
                    operation: input.operation,
                    detail:
                      "GitHub Copilot reasoning effort requires an explicit supported model selection.",
                  }),
                onUnsupportedModel: (modelId) =>
                  new TextGenerationError({
                    operation: input.operation,
                    detail: `GitHub Copilot model '${modelId}' does not support reasoning effort configuration.`,
                  }),
                onUnsupportedReasoningEffort: (modelId, effort) =>
                  new TextGenerationError({
                    operation: input.operation,
                    detail: `GitHub Copilot model '${modelId}' does not support reasoning effort '${effort}'.`,
                  }),
              });
              if (!selectedModel) {
                return yield* new TextGenerationError({
                  operation: input.operation,
                  detail:
                    "GitHub Copilot reasoning effort requires an explicit supported model selection.",
                });
              }
              const effectiveReasoningEffort = selectCopilotReasoningEffort({
                selectedModel,
                explicitReasoningEffort,
                fallbackReasoningEffort: COPILOT_GIT_TEXT_GENERATION_REASONING_EFFORT,
              });

              const attachments = materializeCopilotAttachments(
                serverConfig.attachmentsDir,
                input.attachments,
              );
              const rawOutput = yield* Effect.tryPromise({
                try: async () => {
                  let activeTurnStarted = false;
                  let latestAssistantMessage: string | null = null;
                  let resolveTurnEnd: (() => void) | undefined;
                  const turnEnded = new Promise<void>((resolve) => {
                    resolveTurnEnd = resolve;
                  });
                  const session = await client.createSession({
                    onPermissionRequest: approveAll,
                    model: input.modelSelection.model,
                    ...(effectiveReasoningEffort
                      ? { reasoningEffort: effectiveReasoningEffort }
                      : {}),
                    ...(input.cwd ? { workingDirectory: input.cwd } : {}),
                    ...(configDir ? { configDir } : {}),
                    streaming: false,
                    onEvent: (event) => {
                      if (event.type === "assistant.turn_start") {
                        activeTurnStarted = true;
                        return;
                      }
                      if (event.type === "assistant.message" && activeTurnStarted) {
                        latestAssistantMessage = event.data.content;
                        return;
                      }
                      if (event.type === "assistant.turn_end" && activeTurnStarted) {
                        resolveTurnEnd?.();
                      }
                    },
                  });

                  try {
                    await session.send({
                      prompt: buildStrictJsonPrompt(input.prompt),
                      ...(attachments.length > 0 ? { attachments } : {}),
                      mode: "immediate",
                    });
                    await Promise.race([
                      turnEnded,
                      new Promise<void>((_, reject) => {
                        setTimeout(() => {
                          reject(new Error("GitHub Copilot request timed out."));
                        }, COPILOT_TIMEOUT_MS);
                      }),
                    ]);

                    if (!latestAssistantMessage) {
                      latestAssistantMessage = findLastAssistantMessage(
                        await session.getMessages(),
                      );
                    }
                    if (!latestAssistantMessage || latestAssistantMessage.trim().length === 0) {
                      throw new Error("GitHub Copilot returned an empty response.");
                    }
                    return latestAssistantMessage;
                  } finally {
                    await session.destroy().catch(() => undefined);
                  }
                },
                catch: (cause) =>
                  normalizeCliError(
                    "copilot",
                    input.operation,
                    cause,
                    "GitHub Copilot request failed",
                  ),
              });

              return yield* decodeStructuredOutput({
                operation: input.operation,
                content: rawOutput,
                outputSchema: input.outputSchema,
              });
            }),
          (client) => stopCopilotClient(client),
        );
      });

    const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
      "CopilotTextGeneration.generateCommitMessage",
    )(function* (input) {
      if (input.modelSelection.provider !== "copilot") {
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
      const generated = yield* runCopilotJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchema,
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
      "CopilotTextGeneration.generatePrContent",
    )(function* (input) {
      if (input.modelSelection.provider !== "copilot") {
        return yield* new TextGenerationError({
          operation: "generatePrContent",
          detail: "Invalid model selection.",
        });
      }
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
      });
      const generated = yield* runCopilotJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

    const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
      "CopilotTextGeneration.generateBranchName",
    )(function* (input) {
      if (input.modelSelection.provider !== "copilot") {
        return yield* new TextGenerationError({
          operation: "generateBranchName",
          detail: "Invalid model selection.",
        });
      }
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runCopilotJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

    return {
      generateCommitMessage,
      generatePrContent,
      generateBranchName,
    } satisfies TextGenerationShape;
  });

export const CopilotTextGenerationLive = Layer.effect(TextGeneration, makeCopilotTextGeneration());

export function makeCopilotTextGenerationLive(options?: CopilotTextGenerationLiveOptions) {
  return Layer.effect(TextGeneration, makeCopilotTextGeneration(options));
}
