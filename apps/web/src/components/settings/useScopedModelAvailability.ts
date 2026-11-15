import {
  isProviderTextGenerationCapable,
  textGeneratorForSelection,
  type ProviderInstanceId,
  type TextGenerationOperation,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { isModelEvaluationJudge } from "@t3tools/client-runtime/modelEvaluations";

import { mergeEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { useSettingsScope } from "./SettingsScopeContext";

const OPERATION_LABELS: Record<TextGenerationOperation, string> = {
  generateCommitMessage: "commit messages",
  generatePrContent: "pull request descriptions",
  generateBranchName: "branch names",
  generateThreadTitle: "thread titles",
  generateReviewGuide: "review guides",
  generateTranscriptionPostProcessing: "dictation cleanup",
  generateKnowledgeCandidates: "project knowledge",
  generateConversationSummary: "conversation summaries",
  generateModelEvaluation: "model evaluations",
};

export function useScopedModelDisabledReason(
  settings: UnifiedSettings,
  entries: readonly ProviderInstanceEntry[],
  requiredOperations: readonly TextGenerationOperation[] = [],
) {
  const { targets } = useSettingsScope();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  return (instanceId: ProviderInstanceId, model: string): string | null => {
    const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
    const shownGenerator = textGeneratorForSelection(settings, instanceId);
    for (const candidate of targets) {
      const environment = environments.find(
        (entry) => entry.environmentId === candidate.environmentId,
      );
      const unavailable = `This model is unavailable on ${environment?.label ?? "a selected environment"}. Select that environment to choose its model separately.`;
      const generator = textGeneratorForSelection(candidate.settings, instanceId);
      if (shownGenerator !== undefined || generator !== undefined) {
        if (requiredOperations.includes("generateReviewGuide"))
          return "Choose a coding agent for this setting.";
        // Only the shown environment's model list is loaded; elsewhere it must reach the same API.
        if (
          !generator?.enabled ||
          generator.kind !== shownGenerator?.kind ||
          generator.baseUrl !== shownGenerator.baseUrl
        ) {
          return unavailable;
        }
        continue;
      }
      const providers = providersByEnvironment.get(candidate.environmentId);
      if (!environment?.serverConfig || !providers) continue;
      const entry = applyProviderInstanceSettings(
        deriveProviderInstanceEntries(providers),
        candidate.settings,
        candidate.projectId,
      ).find((option) => option.instanceId === instanceId);
      const options = getCustomModelOptionsByInstance(
        mergeEnvironmentSettings(candidate.settings, settings),
        providers,
      ).get(instanceId);
      if (
        !entry?.enabled ||
        !entry.isAvailable ||
        entry.driverKind !== sourceEntry?.driverKind ||
        !options?.some((option) => option.slug === model && !option.isUnavailable)
      ) {
        const next =
          targets.length > 1
            ? "Select that environment to choose its model separately."
            : "Choose another model.";
        return `This model is unavailable on ${environment?.label ?? "a selected environment"}. ${next}`;
      }
      const provider = providers.find((provider) => provider.instanceId === instanceId);
      const unsupported = requiredOperations.find((operation) =>
        operation === "generateModelEvaluation"
          ? provider === undefined || !isModelEvaluationJudge(provider)
          : provider !== undefined && !isProviderTextGenerationCapable(provider, operation),
      );
      if (unsupported) {
        return `This provider cannot generate ${OPERATION_LABELS[unsupported]} on ${environment.label}. Choose another provider for this setting.`;
      }
    }
    return null;
  };
}
