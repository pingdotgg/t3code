import {
  type ClaudeModelOptions,
  type CopilotModelOptions,
  type CodexModelOptions,
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelCapabilities,
  type ProviderKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { normalizeModelOptionsForProvider, normalizeModelSlug } from "@t3tools/shared/model";
import { COPILOT_BUILT_IN_MODELS } from "@t3tools/shared/copilot";

const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  promptInjectedEffortLevels: [],
};

export function getProviderModels(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): ReadonlyArray<ServerProviderModel> {
  const snapshotModels = providers.find((candidate) => candidate.provider === provider)?.models;
  if (snapshotModels) {
    return snapshotModels;
  }
  return provider === "copilot" ? COPILOT_BUILT_IN_MODELS : [];
}

export function getProviderSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): ServerProvider | undefined {
  return providers.find((candidate) => candidate.provider === provider);
}

export function isProviderEnabled(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): boolean {
  return getProviderSnapshot(providers, provider)?.enabled ?? true;
}

export function resolveSelectableProvider(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind | null | undefined,
): ProviderKind {
  const requested = provider ?? "codex";
  if (isProviderEnabled(providers, requested)) {
    return requested;
  }
  return providers.find((candidate) => candidate.enabled)?.provider ?? requested;
}

export function getProviderModelCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  provider: ProviderKind,
): ModelCapabilities {
  const slug = normalizeModelSlug(model, provider);
  return models.find((candidate) => candidate.slug === slug)?.capabilities ?? EMPTY_CAPABILITIES;
}

export function getDefaultServerModel(
  providers: ReadonlyArray<ServerProvider>,
  provider: ProviderKind,
): string {
  const models = getProviderModels(providers, provider);
  return (
    models.find((model) => !model.isCustom)?.slug ??
    models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[provider]
  );
}

export const normalizeCodexModelOptionsWithCapabilities = (
  caps: ModelCapabilities,
  modelOptions: CodexModelOptions | null | undefined,
) => normalizeModelOptionsForProvider("codex", caps, modelOptions);

export const normalizeClaudeModelOptionsWithCapabilities = (
  caps: ModelCapabilities,
  modelOptions: ClaudeModelOptions | null | undefined,
) => normalizeModelOptionsForProvider("claudeAgent", caps, modelOptions);

export const normalizeCopilotModelOptionsWithCapabilities = (
  caps: ModelCapabilities,
  modelOptions: CopilotModelOptions | null | undefined,
) => normalizeModelOptionsForProvider("copilot", caps, modelOptions);
