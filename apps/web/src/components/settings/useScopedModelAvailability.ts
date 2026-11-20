import {
  isProviderTextGenerationCapable,
  textGeneratorForSelection,
  type ProviderInstanceId,
  type TextGenerationOperation,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { isModelEvaluationJudge } from "@t3tools/client-runtime/modelEvaluations";
import { msg, useGT, useMessages } from "gt-react";

import { mergeEnvironmentSettings } from "../../hooks/useSettings";
import {
  getCustomModelOptionsByInstance,
  getTextGenerationModelOptionsByInstance,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { useSettingsScope } from "./SettingsScopeContext";

const OPERATION_LABELS: Record<TextGenerationOperation, string> = {
  generateCommitMessage: msg("commit messages"),
  generatePrContent: msg("pull request descriptions"),
  generateBranchName: msg("branch names"),
  generateThreadTitle: msg("thread titles"),
  generateReviewGuide: msg("review guides"),
  generateTranscriptionPostProcessing: msg("dictation cleanup"),
  generateKnowledgeCandidates: msg("project knowledge"),
  generateConversationSummary: msg("conversation summaries"),
  generateModelEvaluation: msg("model evaluations"),
  checkFactStanding: msg("project knowledge checks"),
  curateProjectMemory: msg("project memory curation"),
};

export function useScopedModelDisabledReason(
  settings: UnifiedSettings,
  entries: readonly ProviderInstanceEntry[],
  requiredOperations: readonly TextGenerationOperation[] = [],
) {
  const gt = useGT();
  const messages = useMessages();
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
      const unavailable = environment
        ? gt(
            "This model is unavailable on {environment}. Select that environment to choose its model separately.",
            { environment: environment.label },
          )
        : gt(
            "This model is unavailable on a selected environment. Select that environment to choose its model separately.",
          );
      const generator = textGeneratorForSelection(candidate.settings, instanceId);
      if (shownGenerator !== undefined || generator !== undefined) {
        if (requiredOperations.includes("generateReviewGuide"))
          return gt("Choose a coding agent for this setting.");
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
      const optionsForInstance =
        requiredOperations.length > 0
          ? getTextGenerationModelOptionsByInstance
          : getCustomModelOptionsByInstance;
      const options = optionsForInstance(
        mergeEnvironmentSettings(candidate.settings, settings),
        providers,
      ).get(instanceId);
      if (
        !entry?.enabled ||
        !entry.isAvailable ||
        entry.driverKind !== sourceEntry?.driverKind ||
        !options?.some((option) => option.slug === model && !option.isUnavailable)
      ) {
        return targets.length > 1
          ? unavailable
          : gt("This model is unavailable on {environment}. Choose another model.", {
              environment: environment.label,
            });
      }
      const provider = providers.find((provider) => provider.instanceId === instanceId);
      const unsupported = requiredOperations.find((operation) =>
        operation === "generateModelEvaluation"
          ? provider === undefined || !isModelEvaluationJudge(provider)
          : provider !== undefined && !isProviderTextGenerationCapable(provider, operation),
      );
      if (unsupported) {
        return gt(
          "This provider cannot generate {operation} on {environment}. Choose another provider for this setting.",
          { operation: messages(OPERATION_LABELS[unsupported]), environment: environment.label },
        );
      }
    }
    return null;
  };
}
