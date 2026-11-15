import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import {
  isManagedSettingPath,
  textGeneratorForSelection,
  type EnvironmentId,
  type ModelEvaluationGuidance,
  type ProjectId,
  type ProviderInstanceId,
  type ServerSettingsPatch,
  type TextGeneratorConfig,
} from "@t3tools/contracts";
import {
  modelEvaluationGuidanceKey,
  modelEvaluationScoreRows,
  modelEvaluationSelectionLabel,
  isModelEvaluationJudge,
} from "@t3tools/client-runtime/modelEvaluations";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Hash from "effect/Hash";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { RowPressable } from "../../components/ui/RowPressable";
import {
  buildModelMenuActions,
  buildModelOptions,
  groupByProvider,
  type ModelOption,
} from "../../lib/modelOptions";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { modelEvaluations } from "../../state/modelEvaluations";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { apiJudgeModelsAtom } from "./modelEvaluationApiModels";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function ModelEvaluationSettings() {
  const { selectedTargets, selectedProjectKey, projectGroups } = useSettingsEnvironmentFilter();
  const supported = selectedTargets.filter(
    (target) => target.serverConfig.environment.capabilities.modelEvaluations === true,
  );
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  return (
    <View className="gap-4">
      <Text className="px-2 text-sm text-foreground-muted">
        Scores completed tasks to build project guidance. Model and provider labels are removed
        before judging.
      </Text>
      {supported.length !== selectedTargets.length || supported.length === 0 ? (
        <Text className="px-2 text-sm text-foreground-muted">
          Connect or update an environment to use model evaluations.
        </Text>
      ) : null}
      {supported.map((target) => (
        <EnvironmentEvaluationSettings
          key={target.environmentId}
          environmentId={target.environmentId}
          label={target.label}
          scopedProjectId={
            selectedProject?.members.find(
              (member) => member.project.environmentId === target.environmentId,
            )?.project.id ?? null
          }
          projectSelected={selectedProjectKey !== null}
        />
      ))}
    </View>
  );
}

function EnvironmentEvaluationSettings(props: {
  environmentId: EnvironmentId;
  label: string;
  scopedProjectId: ProjectId | null;
  projectSelected: boolean;
}) {
  const { environmentId, label } = props;
  const config = useEnvironmentServerConfig(environmentId);
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [chosenProjectId, setChosenProjectId] = useState<ProjectId | null>(null);
  const [saving, setSaving] = useState(false);
  const canListModels = useAtomValue(
    serverEnvironment.listTextGeneratorModels.permissionAtom(environmentId),
  );
  const apiJudges = (
    canListModels && config !== null
      ? (Object.entries(config.settings.textGenerators) as Array<
          [ProviderInstanceId, TextGeneratorConfig]
        >)
      : []
  ).filter(([, generator]) => generator.enabled);
  const apiModelsAtom = apiJudgeModelsAtom(
    JSON.stringify(
      apiJudges.map(
        ([id, generator]) => [environmentId, id, Hash.string(JSON.stringify(generator))] as const,
      ),
    ),
  );
  const apiModelLists = useAtomValue(apiModelsAtom);
  const refreshApiModels = useAtomRefresh(apiModelsAtom);
  if (config === null) return null;
  const readOnly = saving || !canWrite || props.projectSelected;
  const project =
    projects.find(
      (item) => item.id === (props.projectSelected ? props.scopedProjectId : chosenProjectId),
    ) ?? null;
  const settings = config.settings;
  const selection = settings.modelEvaluationModelSelection ?? settings.textGenerationModelSelection;
  const capable = new Set(
    config.providers.filter(isModelEvaluationJudge).map((provider) => provider.instanceId),
  );
  const listedApiModels = apiModelLists.map((result) => AsyncResult.getOrElse(result, () => []));
  const apiModelsLoading = apiModelLists.some((result) => result.waiting);
  const failedApis = apiJudges.flatMap(([, generator], index) =>
    apiModelLists[index]?._tag === "Failure" ? [generator.label || generator.baseUrl] : [],
  );
  const models = [
    ...buildModelOptions(config, selection, undefined, null).filter(
      (model) =>
        capable.has(model.selection.instanceId) &&
        !model.isUnavailable &&
        textGeneratorForSelection(settings, model.selection.instanceId) === undefined,
    ),
    ...apiJudges.flatMap(([instanceId, generator], index) =>
      (listedApiModels[index] ?? []).map((model): ModelOption => ({
        key: `${instanceId}:${model.id}`,
        label: model.name,
        subtitle: "",
        providerKey: instanceId,
        providerLabel: generator.label || generator.baseUrl,
        providerDriver: generator.kind,
        isDefault: false,
        isLegacy: false,
        capabilities: null,
        selection: { instanceId, model: model.id },
      })),
    ),
  ];
  const selectedProvider = config.providers.find(
    (provider) => provider.instanceId === selection.instanceId,
  );
  const selectedApi = textGeneratorForSelection(settings, selection.instanceId);
  const judgeAvailable =
    selectedApi !== undefined
      ? selectedApi.enabled
      : selectedProvider?.installed === true &&
        selectedProvider.status !== "error" &&
        selectedProvider.auth.status !== "unauthenticated" &&
        selectedProvider.availability !== "unavailable" &&
        models.some(
          (model) =>
            model.selection.instanceId === selection.instanceId &&
            model.selection.model === selection.model,
        );
  const write = async (patch: ServerSettingsPatch) => {
    if (readOnly) return;
    setSaving(true);
    const result = await update({ environmentId, input: { patch } });
    setSaving(false);
    if (result._tag === "Failure")
      Dialog.alert("Could not save model evaluations", String(squashAtomCommandFailure(result)));
  };
  const disabledFor = (key: string) => readOnly || isManagedSettingPath(config.managedPolicy, key);
  const actions: MenuAction[] = [
    {
      id: "default",
      title: "Use text generation model",
      state: settings.modelEvaluationModelSelection === null ? "on" : undefined,
    },
    ...buildModelMenuActions(groupByProvider(models), selection),
  ];
  return (
    <SettingsSection title={`Model evaluations · ${label}`}>
      <SettingsSwitchRow
        icon="flask"
        label="Blind model evaluations"
        subtitle={
          props.projectSelected
            ? "Environment-wide setting. Select all projects to change it."
            : "Each evaluation uses an additional model call."
        }
        value={settings.enableModelEvaluations}
        disabled={
          disabledFor("enableModelEvaluations") ||
          (!settings.enableModelEvaluations && !judgeAvailable)
        }
        onValueChange={(enabled) => {
          if (!enabled || judgeAvailable) void write({ enableModelEvaluations: enabled });
        }}
      />
      <EvaluationMenu
        label="Judge model"
        value={modelEvaluationSelectionLabel(selection)}
        disabled={disabledFor("modelEvaluationModelSelection")}
        actions={actions}
        onSelect={(key) => {
          if (key === "default") {
            void write({ modelEvaluationModelSelection: null });
            return;
          }
          const model = models.find((candidate) => `model:${candidate.key}` === key);
          if (model) void write({ modelEvaluationModelSelection: model.selection });
        }}
      />
      {apiJudges.length > 0 ? (
        <View className="gap-2 px-4 py-2">
          {failedApis.length > 0 ? (
            <Text className="text-sm text-foreground-muted">
              Could not load models from {failedApis.join(", ")}.
            </Text>
          ) : null}
          <Button
            label={apiModelsLoading ? "Loading API models…" : "Refresh API models"}
            tone="text"
            disabled={apiModelsLoading}
            onPress={refreshApiModels}
          />
        </View>
      ) : null}
      {!judgeAvailable ? (
        <Text className="px-4 py-2 text-sm text-foreground-muted">
          Choose an available judge before enabling.
        </Text>
      ) : null}
      <EvaluationMenu
        label="Project guidance"
        value={project?.title ?? "Choose a project"}
        disabled={props.projectSelected || projects.length === 0}
        actions={projects.map((item) => ({
          id: item.id,
          title: item.title,
          state: item.id === project?.id ? "on" : undefined,
        }))}
        onSelect={(id) => {
          const selected = projects.find((item) => item.id === id);
          if (selected) setChosenProjectId(selected.id);
        }}
      />
      {project ? (
        <ProjectEvaluationReport
          key={project.id}
          environmentId={environmentId}
          projectId={project.id}
          projectTitle={project.title}
          enabled={settings.enableModelEvaluations}
        />
      ) : (
        <Text className="px-4 py-3 text-sm text-foreground-muted">
          Choose a project to view its evaluations and guidance.
        </Text>
      )}
    </SettingsSection>
  );
}

function EvaluationMenu(props: {
  label: string;
  value: string;
  disabled: boolean;
  actions: MenuAction[];
  onSelect: (id: string) => void;
}) {
  return (
    <Menu
      actions={props.disabled ? [] : props.actions}
      onPressAction={({ nativeEvent }) => {
        if (!props.disabled) props.onSelect(nativeEvent.event);
      }}
    >
      <RowPressable
        disabled={props.disabled}
        accessibilityRole="button"
        accessibilityLabel={`${props.label}, ${props.value}`}
        accessibilityState={{ disabled: props.disabled }}
        className="gap-1 px-4 py-3"
      >
        <Text className="text-base text-foreground">{props.label}</Text>
        <Text className="text-sm text-foreground-muted">{props.value}</Text>
      </RowPressable>
    </Menu>
  );
}

function ProjectEvaluationReport(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectTitle: string;
  enabled: boolean;
}) {
  const query = useEnvironmentQuery(
    modelEvaluations.list({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const canClear = useAtomValue(modelEvaluations.clear.permissionAtom(props.environmentId));
  const clear = useAtomCommand(modelEvaluations.clear, { reportFailure: false });
  const [clearing, setClearing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const clearHistory = async () => {
    setClearing(true);
    const result = await clear({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    });
    setClearing(false);
    if (result._tag === "Failure")
      Dialog.alert("Could not clear evaluations", String(squashAtomCommandFailure(result)));
  };
  return (
    <View className="gap-3 px-4 py-3">
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Refresh"
          tone="secondary"
          disabled={clearing || query.isPending}
          onPress={query.refresh}
        />
        <Button
          label="Clear history"
          tone="text"
          disabled={!canClear || clearing || query.isPending || !query.data?.records.length}
          onPress={() =>
            Dialog.confirm({
              title: `Clear evaluations for ${props.projectTitle}?`,
              message: "This deletes this project's saved scores and learned guidance.",
              confirmText: "Clear history",
              destructive: true,
              onConfirm: () => void clearHistory(),
            })
          }
        />
      </View>
      {query.error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {query.error}
        </Text>
      ) : null}
      {query.isPending || clearing ? (
        <Text className="text-sm text-foreground-muted">Loading evaluations…</Text>
      ) : query.data && !query.error ? (
        <>
          <Text className="text-sm text-foreground-muted">
            Up to {query.data.windowLimit} evaluations from the past 90 days. Scores use 0–4;
            unknown dimensions stay unscored. Small samples and judge opinions are advisory.
            {!props.enabled ? " Evaluations are off; saved history is still available." : ""}
          </Text>
          {query.data.records.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              No evaluations yet. Complete a task with evaluations enabled to collect scores.
            </Text>
          ) : null}
          {query.data.guidance.map((guidance) => (
            <GuidanceCard key={modelEvaluationGuidanceKey(guidance)} guidance={guidance} />
          ))}
          {query.data.records.length > 0 ? (
            <Button
              label={`${showHistory ? "Hide" : "Show"} recent evaluations (${query.data.records.length})`}
              tone="text"
              onPress={() => setShowHistory(!showHistory)}
            />
          ) : null}
          {showHistory
            ? query.data.records.map((record) => (
                <View key={record.runId} className="gap-1 border-t border-border-subtle py-3">
                  <Text className="text-sm font-t3-medium text-foreground">
                    {modelEvaluationSelectionLabel(record.modelSelection)}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    {record.scope} · {record.status.replaceAll("_", " ")} ·{" "}
                    {new Date(record.at).toLocaleString()}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    Judge: {modelEvaluationSelectionLabel(record.evaluatorSelection)} ·{" "}
                    {record.rubricVersion}
                  </Text>
                  {record.verdict ? (
                    <Text className="text-sm text-foreground">{record.verdict.rationale.text}</Text>
                  ) : null}
                  {record.reason ? (
                    <Text className="text-sm text-foreground">{record.reason}</Text>
                  ) : null}
                </View>
              ))
            : null}
        </>
      ) : null}
    </View>
  );
}

function GuidanceCard({ guidance }: { guidance: ModelEvaluationGuidance }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View className="rounded-xl border border-border-subtle">
      <RowPressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="gap-1 p-3"
      >
        <Text className="text-sm font-t3-medium text-foreground">
          {modelEvaluationSelectionLabel(guidance.modelSelection)} · {guidance.taskCategory} ·{" "}
          {guidance.scope}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {guidance.sampleCount} scored · {guidance.confidence}
        </Text>
      </RowPressable>
      {expanded ? (
        <View className="gap-3 px-3 pb-3">
          <Text className="text-xs text-foreground-muted">
            Judge: {modelEvaluationSelectionLabel(guidance.evaluatorSelection)} ·{" "}
            {guidance.rubricVersion}
          </Text>
          {modelEvaluationScoreRows(guidance).map((score) => (
            <Text key={score.key} className="text-sm text-foreground">
              {score.label}: {score.value} ({score.count} scored)
            </Text>
          ))}
          <Text className="text-xs text-foreground-muted">
            {guidance.insufficientEvidenceCount} observations lacked sufficient evidence.
          </Text>
          {guidance.sampleCount > 0 ? (
            <Text className="text-xs text-foreground-muted">
              Observed prompt lengths: {guidance.promptChars.min.toLocaleString()}–
              {guidance.promptChars.max.toLocaleString()} characters (median{" "}
              {Math.round(guidance.promptChars.median).toLocaleString()}); this is not a
              context-window limit.
            </Text>
          ) : null}
          <ObservationList title="Observed strengths" items={guidance.strengths} />
          <ObservationList title="Observed limitations" items={guidance.weaknesses} />
          <ObservationList title="Prompting guidance" items={guidance.promptAdvice} />
        </View>
      ) : null}
    </View>
  );
}

function ObservationList({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <View className="gap-1">
      <Text className="text-xs font-t3-medium text-foreground">{title}</Text>
      {items.map((item) => (
        <Text key={item} className="text-sm text-foreground">
          • {item}
        </Text>
      ))}
    </View>
  );
}
