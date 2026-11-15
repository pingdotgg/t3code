import {
  type OllamaInstalledModel,
  ProviderDriverKind,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { ollamaModelSupportsAgents } from "@t3tools/shared/ollamaCatalog";

import { DEFAULT_OLLAMA_BASE_URL, ollamaAgentVariantName } from "./ollamaRuntime.ts";

/**
 * Codex's built-in `ollama` model provider talks to Ollama's OpenAI-compatible API, so local
 * models get Codex's whole agent loop: shell, file edits, and approvals.
 */
export const OLLAMA_CODEX_LAUNCH_ARGS = "-c model_provider=ollama";

function ollamaAgentModels(
  models: ReadonlyArray<OllamaInstalledModel>,
): ReadonlyArray<{ readonly slug: string; readonly name: string }> {
  return models
    .filter(ollamaModelSupportsAgents)
    .map((model) => ({ slug: ollamaAgentVariantName(model.name), name: `${model.name} (local)` }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function buildOllamaAgentInstance(input: {
  readonly baseUrl: string;
  readonly codexHome: string;
  /** Empty uses `codex` from PATH. */
  readonly codexBinaryPath: string;
  readonly models: ReadonlyArray<OllamaInstalledModel>;
}): ProviderInstanceConfig {
  return {
    driver: ProviderDriverKind.make("codex"),
    displayName: "Ollama (local)",
    enabled: true,
    environment:
      input.baseUrl === DEFAULT_OLLAMA_BASE_URL
        ? []
        : [{ name: "CODEX_OSS_BASE_URL", value: `${input.baseUrl}/v1`, sensitive: false }],
    config: {
      ...(input.codexBinaryPath === "" ? {} : { binaryPath: input.codexBinaryPath }),
      launchArgs: OLLAMA_CODEX_LAUNCH_ARGS,
      // Local sessions keep their own Codex history, apart from the user's OpenAI one.
      homePath: input.codexHome,
      customModels: ollamaAgentModels(input.models),
    },
  };
}

/** True when the stored instance already lists exactly these models. */
export function ollamaAgentInstanceIsCurrent(
  current: ProviderInstanceConfig | undefined,
  next: ProviderInstanceConfig,
): boolean {
  if (current === undefined) return false;
  const currentModels = (current.config as { customModels?: unknown } | undefined)?.customModels;
  const nextModels = (next.config as { customModels?: unknown }).customModels;
  return JSON.stringify(currentModels ?? []) === JSON.stringify(nextModels ?? []);
}

/** The Codex executable an existing agent instance was set up with. */
export function ollamaAgentCodexBinaryPath(current: ProviderInstanceConfig | undefined): string {
  const binaryPath = (current?.config as { binaryPath?: unknown } | undefined)?.binaryPath;
  return typeof binaryPath === "string" ? binaryPath : "";
}
