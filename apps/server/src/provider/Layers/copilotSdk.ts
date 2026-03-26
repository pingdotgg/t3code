import { Effect } from "effect";
import type { ChatAttachment, CodexReasoningEffort, CopilotSettings } from "@t3tools/contracts";
import type { CopilotClientOptions, ModelInfo } from "@github/copilot-sdk";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { normalizeCopilotCliPathOverride, resolveBundledCopilotCliPath } from "./copilotCliPath.ts";

export interface CopilotModelMetadataClient {
  start(): Promise<void>;
  listModels(): Promise<ReadonlyArray<ModelInfo>>;
}

export interface StoppableCopilotClient {
  stop(): Promise<ReadonlyArray<Error>>;
}

export interface CopilotFileAttachment {
  readonly type: "file";
  readonly path: string;
  readonly displayName?: string;
}

export function trimToUndefined(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveCopilotRuntimeConfig(
  settings: Pick<CopilotSettings, "binaryPath" | "configDir">,
  cwd: string | undefined,
): {
  readonly clientOptions: CopilotClientOptions;
  readonly configDir: string | undefined;
} {
  const cliPath =
    normalizeCopilotCliPathOverride(settings.binaryPath) ?? resolveBundledCopilotCliPath();
  return {
    clientOptions: {
      ...(cliPath ? { cliPath } : {}),
      ...(cwd ? { cwd } : {}),
      logLevel: "error",
    },
    configDir: trimToUndefined(settings.configDir),
  };
}

export function stopCopilotClient(client: StoppableCopilotClient): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => client.stop(),
    catch: () => undefined,
  }).pipe(
    Effect.catch(() => Effect.void),
    Effect.asVoid,
  );
}

export function mapSupportedModelsById(models: ReadonlyArray<ModelInfo>) {
  return new Map(models.map((model) => [model.id, model]));
}

export function loadCopilotSupportedModels<E>(input: {
  readonly client: CopilotModelMetadataClient;
  readonly onStartError: (cause: unknown) => E;
  readonly onListError: (cause: unknown) => E;
}): Effect.Effect<Map<string, ModelInfo>, E> {
  return Effect.tryPromise({
    try: () => input.client.start(),
    catch: input.onStartError,
  }).pipe(
    Effect.flatMap(() =>
      Effect.tryPromise({
        try: () => input.client.listModels(),
        catch: input.onListError,
      }),
    ),
    Effect.map((models) => mapSupportedModelsById(models)),
  );
}

export function resolveCopilotSelectedModel<E>(input: {
  readonly supportedModels: ReadonlyMap<string, ModelInfo>;
  readonly model: string | undefined;
  readonly onMissingModel: (model: string) => E;
}): Effect.Effect<ModelInfo | undefined, E> {
  if (!input.model) {
    return Effect.void as Effect.Effect<ModelInfo | undefined, E>;
  }
  const selectedModel = input.supportedModels.get(input.model);
  if (!selectedModel) {
    return Effect.fail(input.onMissingModel(input.model));
  }
  return Effect.succeed(selectedModel);
}

export function validateCopilotReasoningEffort<E>(input: {
  readonly selectedModel: ModelInfo | undefined;
  readonly reasoningEffort: CodexReasoningEffort | undefined;
  readonly onMissingModel: () => E;
  readonly onUnsupportedModel: (modelId: string) => E;
  readonly onUnsupportedReasoningEffort: (modelId: string, effort: CodexReasoningEffort) => E;
}): Effect.Effect<void, E> {
  if (!input.reasoningEffort) {
    return Effect.void;
  }
  if (!input.selectedModel) {
    return Effect.fail(input.onMissingModel());
  }
  const supportedReasoningEfforts = input.selectedModel.supportedReasoningEfforts ?? [];
  if (supportedReasoningEfforts.length === 0) {
    return Effect.fail(input.onUnsupportedModel(input.selectedModel.id));
  }
  if (!supportedReasoningEfforts.includes(input.reasoningEffort)) {
    return Effect.fail(
      input.onUnsupportedReasoningEffort(input.selectedModel.id, input.reasoningEffort),
    );
  }
  return Effect.void;
}

export function selectCopilotReasoningEffort(input: {
  readonly selectedModel: ModelInfo;
  readonly explicitReasoningEffort: CodexReasoningEffort | undefined;
  readonly fallbackReasoningEffort: CodexReasoningEffort;
}): CodexReasoningEffort | undefined {
  if (input.explicitReasoningEffort) {
    return input.explicitReasoningEffort;
  }
  return input.selectedModel.supportedReasoningEfforts?.includes(input.fallbackReasoningEffort)
    ? input.fallbackReasoningEffort
    : undefined;
}

export function materializeCopilotAttachments(
  attachmentsDir: string,
  attachments: ReadonlyArray<ChatAttachment> | undefined,
): Array<CopilotFileAttachment> {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const results: Array<CopilotFileAttachment> = [];
  for (const attachment of attachments) {
    const resolvedPath = resolveAttachmentPath({
      attachmentsDir,
      attachment,
    });
    if (!resolvedPath) {
      continue;
    }
    results.push({
      type: "file",
      path: resolvedPath,
      displayName: attachment.name,
    });
  }
  return results;
}
