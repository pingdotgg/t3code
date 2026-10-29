import { useNavigation } from "@react-navigation/native";
import { withoutPlanAgentOption } from "@t3tools/shared/model";
import { useMemo } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { useEnvironmentServerConfig } from "../../state/entities";
import { ThreadSettingsPickerScreen } from "../threads/ThreadSettingsSheet";
import { SettingsScreen } from "./components/SettingsScreen";
import { usePipelineEditor } from "./pipeline-editor";
import type { PipelineStepDraft } from "@t3tools/client-runtime/pipeline-editor";

function MissingPipelineDraft() {
  return (
    <SettingsScreen title="Pipeline">
      <Text className="p-5 text-base text-foreground-muted">Open a pipeline form first.</Text>
    </SettingsScreen>
  );
}

/** Model, effort and permissions for the step the form opened the picker for. */
export function PipelineStepModelPickerRouteScreen() {
  const navigation = useNavigation();
  const { editor, setEditor } = usePipelineEditor();
  const config = useEnvironmentServerConfig(editor?.environmentId ?? null);
  const step = editor?.draft.steps.find((entry) => entry.key === editor.modelStepId) ?? null;
  const selectedModel = step?.modelSelection ?? null;
  const models = useMemo(
    () => buildModelOptions(config, selectedModel, undefined, null),
    [config, selectedModel],
  );
  const providerGroups = useMemo(() => groupByProvider(models), [models]);
  const selectedOption = models.find(
    (option) =>
      option.selection.instanceId === selectedModel?.instanceId &&
      option.selection.model === selectedModel.model,
  );
  const optionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        // Pipelines have no plan mode, so OpenCode's plan agent is not offered.
        capabilities: selectedOption?.capabilities
          ? withoutPlanAgentOption(selectedOption.capabilities)
          : undefined,
        selections: selectedModel?.options,
      }),
    [selectedOption, selectedModel?.options],
  );

  if (!editor || !step) return <MissingPipelineDraft />;

  const updateStep = (update: (current: PipelineStepDraft) => PipelineStepDraft) =>
    setEditor((current) =>
      current
        ? {
            ...current,
            draft: {
              ...current.draft,
              steps: current.draft.steps.map((entry) =>
                entry.key === step.key ? update(entry) : entry,
              ),
            },
          }
        : current,
    );

  return (
    <ThreadSettingsPickerScreen
      environmentId={editor.environmentId}
      projectId={null}
      providerGroups={providerGroups}
      selectedModel={selectedModel}
      prompt={step.promptTemplate}
      onPromptChange={(promptTemplate) => updateStep((entry) => ({ ...entry, promptTemplate }))}
      onSelectModel={(option) =>
        updateStep((entry) => ({ ...entry, modelSelection: option.selection }))
      }
      optionDescriptors={optionDescriptors}
      onUpdateOptionSelections={(options) =>
        updateStep((entry) =>
          entry.modelSelection
            ? { ...entry, modelSelection: { ...entry.modelSelection, options } }
            : entry,
        )
      }
      runtimeMode={step.runtimeMode}
      onUpdateRuntimeMode={(runtimeMode) => updateStep((entry) => ({ ...entry, runtimeMode }))}
      onClose={() => navigation.goBack()}
    />
  );
}
