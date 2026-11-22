import { T, Var, useGT, useMessages } from "gt-react-native";
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
        <T>
          Scores completed tasks to build project guidance. Model and provider labels are removed
          before judging.
        </T>
      </Text>
      {supported.length !== selectedTargets.length || supported.length === 0 ? (
        <Text className="px-2 text-sm text-foreground-muted">
          <T>Connect or update an environment to use model evaluations.</T>
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
  const gt = useGT();
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
      Dialog.alert(
        gt("Could not save model evaluations"),
        String(squashAtomCommandFailure(result)),
      );
  };
  const disabledFor = (key: string) => readOnly || isManagedSettingPath(config.managedPolicy, key);
  const actions: MenuAction[] = [
    {
      id: "default",
      title: gt("Use text generation model"),
      state: settings.modelEvaluationModelSelection === null ? "on" : undefined,
    },
    ...buildModelMenuActions(groupByProvider(models), selection),
  ];
  return (
    <SettingsSection title={gt("Model evaluations · {environment}", { environment: label })}>
      <SettingsSwitchRow
        icon="flask"
        label={gt("Blind model evaluations")}
        subtitle={
          props.projectSelected
            ? gt("Environment-wide setting. Select all projects to change it.")
            : gt("Each evaluation uses an additional model call.")
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
        label={gt("Judge model")}
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
              <T>
                Could not load models from <Var>{failedApis.join(", ")}</Var>.
              </T>
            </Text>
          ) : null}
          <Button
            label={apiModelsLoading ? gt("Loading API models…") : gt("Refresh API models")}
            tone="text"
            disabled={apiModelsLoading}
            onPress={refreshApiModels}
          />
        </View>
      ) : null}
      {!judgeAvailable ? (
        <Text className="px-4 py-2 text-sm text-foreground-muted">
          <T>Choose an available judge before enabling.</T>
        </Text>
      ) : null}
      <EvaluationMenu
        label={gt("Project guidance")}
        value={project?.title ?? gt("Choose a project")}
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
          <T>Choose a project to view its evaluations and guidance.</T>
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
  const gt = useGT();
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
      Dialog.alert(gt("Could not clear evaluations"), String(squashAtomCommandFailure(result)));
  };
  return (
    <View className="gap-3 px-4 py-3">
      <View className="flex-row flex-wrap gap-2">
        <Button
          label={gt("Refresh")}
          tone="secondary"
          disabled={clearing || query.isPending}
          onPress={query.refresh}
        />
        <Button
          label={gt("Clear history")}
          tone="text"
          disabled={!canClear || clearing || query.isPending || !query.data?.records.length}
          onPress={() =>
            Dialog.confirm({
              title: gt("Clear evaluations for {project}?", { project: props.projectTitle }),
              message: gt("This deletes this project's saved scores and learned guidance."),
              confirmText: gt("Clear history"),
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
        <Text className="text-sm text-foreground-muted">
          <T>Loading evaluations…</T>
        </Text>
      ) : query.data && !query.error ? (
        <>
          <Text className="text-sm text-foreground-muted">
            <T>
              Up to <Var>{query.data.windowLimit}</Var> evaluations from the past 90 days. Scores
              use 0–4; unknown dimensions stay unscored. Small samples and judge opinions are
              advisory.
            </T>
            {!props.enabled ? (
              <>
                {" "}
                <T>Evaluations are off; saved history is still available.</T>
              </>
            ) : null}
          </Text>
          {query.data.records.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              <T>No evaluations yet. Complete a task with evaluations enabled to collect scores.</T>
            </Text>
          ) : null}
          {query.data.guidance.map((guidance) => (
            <GuidanceCard key={modelEvaluationGuidanceKey(guidance)} guidance={guidance} />
          ))}
          {query.data.records.length > 0 ? (
            <Button
              label={
                showHistory
                  ? gt("Hide recent evaluations ({count})", { count: query.data.records.length })
                  : gt("Show recent evaluations ({count})", { count: query.data.records.length })
              }
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
                    <T>
                      Judge: <Var>{modelEvaluationSelectionLabel(record.evaluatorSelection)}</Var> ·{" "}
                      <Var>{record.rubricVersion}</Var>
                    </T>
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
  const gt = useGT();
  const messages = useMessages();
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
          {gt("{count} scored · {confidence}", {
            count: guidance.sampleCount,
            confidence: guidance.confidence,
          })}
        </Text>
      </RowPressable>
      {expanded ? (
        <View className="gap-3 px-3 pb-3">
          <Text className="text-xs text-foreground-muted">
            <T>
              Judge: <Var>{modelEvaluationSelectionLabel(guidance.evaluatorSelection)}</Var> ·{" "}
              <Var>{guidance.rubricVersion}</Var>
            </T>
          </Text>
          {modelEvaluationScoreRows(guidance, messages).map((score) => (
            <Text key={score.key} className="text-sm text-foreground">
              {gt("{label}: {value} ({count} scored)", {
                label: score.label,
                value: score.value,
                count: score.count,
              })}
            </Text>
          ))}
          <Text className="text-xs text-foreground-muted">
            {gt("{count} observations lacked sufficient evidence.", {
              count: guidance.insufficientEvidenceCount,
            })}
          </Text>
          {guidance.sampleCount > 0 ? (
            <Text className="text-xs text-foreground-muted">
              {gt(
                "Observed prompt lengths: {min}–{max} characters (median {median}); this is not a context-window limit.",
                {
                  min: guidance.promptChars.min.toLocaleString(),
                  max: guidance.promptChars.max.toLocaleString(),
                  median: Math.round(guidance.promptChars.median).toLocaleString(),
                },
              )}
            </Text>
          ) : null}
          <ObservationList title={gt("Observed strengths")} items={guidance.strengths} />
          <ObservationList title={gt("Observed limitations")} items={guidance.weaknesses} />
          <ObservationList title={gt("Prompting guidance")} items={guidance.promptAdvice} />
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
