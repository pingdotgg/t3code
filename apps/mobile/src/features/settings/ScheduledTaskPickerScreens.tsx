import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useMemo, useState } from "react";

import { AppText as Text } from "../../components/AppText";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { useDebouncedValue, usePaginatedBranches } from "../../state/queries";
import { BranchPickerScreen } from "../threads/NewTaskContextPickerScreens";
import { ThreadSettingsPickerScreen } from "../threads/ThreadSettingsSheet";
import { SettingsScreen } from "./components/SettingsScreen";
import { useScheduledTaskEditor } from "./scheduled-task-editor";

function MissingTaskDraft() {
  return (
    <SettingsScreen title="Scheduled task">
      <Text className="p-5 text-base text-foreground-muted">Open a scheduled task form first.</Text>
    </SettingsScreen>
  );
}

export function ScheduledTaskModelPickerRouteScreen() {
  const navigation = useNavigation();
  const { editor, setEditor } = useScheduledTaskEditor();
  const config = useEnvironmentServerConfig(editor?.environmentId ?? null);
  const selectedModel = editor?.draft.modelSelection ?? null;
  const models = useMemo(() => buildModelOptions(config, selectedModel), [config, selectedModel]);
  const providerGroups = useMemo(() => groupByProvider(models), [models]);
  const selectedOption = models.find(
    (option) =>
      option.selection.instanceId === selectedModel?.instanceId &&
      option.selection.model === selectedModel.model,
  );
  const optionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: selectedOption?.capabilities,
        selections: selectedModel?.options,
      }),
    [selectedOption?.capabilities, selectedModel?.options],
  );

  if (!editor) return <MissingTaskDraft />;

  return (
    <ThreadSettingsPickerScreen
      environmentId={editor.environmentId}
      providerGroups={providerGroups}
      selectedModel={selectedModel}
      onSelectModel={(option) =>
        setEditor((current) =>
          current
            ? {
                ...current,
                draft: { ...current.draft, modelSelection: option.selection },
              }
            : current,
        )
      }
      optionDescriptors={optionDescriptors}
      onUpdateOptionSelections={(options) =>
        setEditor((current) =>
          current?.draft.modelSelection
            ? {
                ...current,
                draft: {
                  ...current.draft,
                  modelSelection: { ...current.draft.modelSelection, options },
                },
              }
            : current,
        )
      }
      runtimeMode={editor.draft.runtimeMode}
      onUpdateRuntimeMode={(runtimeMode) =>
        setEditor((current) =>
          current
            ? {
                ...current,
                draft: { ...current.draft, runtimeMode },
              }
            : current,
        )
      }
      onClose={() => navigation.goBack()}
    />
  );
}

export function ScheduledTaskBranchPickerRouteScreen() {
  const navigation = useNavigation();
  const { editor, setEditor } = useScheduledTaskEditor();
  const projects = useProjects();
  const project =
    projects.find(
      (entry) =>
        entry.environmentId === editor?.environmentId && entry.id === editor.draft.projectId,
    ) ?? null;
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 150);
  const branches = usePaginatedBranches({
    environmentId: editor?.environmentId ?? null,
    cwd: project?.workspaceRoot ?? null,
    query: debouncedQuery,
  });
  const visibleBranches = branches.refs.filter(
    (branch) => !branch.isRemote && branch.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  if (!editor) return <MissingTaskDraft />;

  return (
    <BranchPickerScreen
      title="Base branch"
      project={project}
      branches={visibleBranches}
      selectedBranchName={editor.draft.baseRef}
      query={query}
      onQueryChange={setQuery}
      loading={
        query.trim() !== debouncedQuery.trim() || (branches.isPending && branches.data === null)
      }
      error={project ? branches.error : "This project is no longer available."}
      refreshing={branches.isFetchingNextPage}
      hasMore={branches.data?.nextCursor != null}
      onRefresh={branches.refresh}
      onLoadMore={branches.loadNext}
      onSelect={(branch) => {
        void Haptics.selectionAsync();
        setEditor((current) =>
          current ? { ...current, draft: { ...current.draft, baseRef: branch.name } } : current,
        );
        navigation.goBack();
      }}
      worktree={{
        startFromOrigin: editor.draft.startFromOrigin,
        onChangeStartFromOrigin: (startFromOrigin) =>
          setEditor((current) =>
            current
              ? {
                  ...current,
                  draft: { ...current.draft, startFromOrigin },
                }
              : current,
          ),
      }}
    />
  );
}
