import { useAtomValue } from "@effect/atom-react";
import {
  resolveProjectProviderInstanceEnabled,
  type EnvironmentId,
  type ModelEvaluationGuidance,
  type ProjectId,
} from "@t3tools/contracts";
import {
  modelEvaluationGuidanceKey,
  modelEvaluationScoreRows,
  modelEvaluationSelectionLabel,
  isModelEvaluationJudge,
} from "@t3tools/client-runtime/modelEvaluations";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { createModelSelection } from "@t3tools/shared/model";
import * as Equal from "effect/Equal";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { mergeEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { modelEvaluations } from "../../state/modelEvaluations";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function ModelEvaluationSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, connectedEnvironments, targets } = useSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  const supportedEnvironments = connectedEnvironments.filter(
    (target) => target.serverConfig?.environment.capabilities.modelEvaluations === true,
  );
  const supported =
    supportedEnvironments.length > 0 &&
    supportedEnvironments.length === connectedEnvironments.length;
  const providers =
    (environment ? providersByEnvironment.get(environment.environmentId) : undefined) ??
    EMPTY_SERVER_PROVIDERS;
  const judgeProviders = providers.filter(isModelEvaluationJudge);
  const selection = settings.modelEvaluationModelSelection ?? settings.textGenerationModelSelection;
  const entries = providerInstanceEntriesFor(judgeProviders, settings, null);
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    judgeProviders,
    selection.instanceId,
    selection.model,
  );
  const disabledReason = useScopedModelDisabledReason(settings, entries, [
    "generateModelEvaluation",
  ]);
  const selectionIssue = disabledReason(selection.instanceId, selection.model);
  const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
  const mixedJudge =
    useScopedSettingsMixed(["modelEvaluationModelSelection"]) ||
    targets.some(
      (target) =>
        !Equal.equals(
          selection,
          target.settings.modelEvaluationModelSelection ??
            target.settings.textGenerationModelSelection,
        ),
    );
  const mixedEnabled = useScopedSettingsMixed(["enableModelEvaluations"]);
  const unavailableEnvironments = targets.flatMap((target) => {
    const judge =
      target.settings.modelEvaluationModelSelection ?? target.settings.textGenerationModelSelection;
    const provider = providersByEnvironment
      .get(target.environmentId)
      ?.find(
        (candidate) =>
          candidate.instanceId === judge.instanceId && isModelEvaluationJudge(candidate),
      );
    if (
      !provider ||
      !resolveProjectProviderInstanceEnabled(target.settings, null, judge.instanceId) ||
      provider.availability === "unavailable" ||
      !provider.installed ||
      provider.status === "error" ||
      provider.auth.status === "unauthenticated"
    )
      return [target.label];
    const models = getCustomModelOptionsByInstance(
      mergeEnvironmentSettings(target.settings, settings),
      [provider],
      judge.instanceId,
      judge.model,
    ).get(judge.instanceId);
    return models?.some((model) => model.slug === judge.model && !model.isUnavailable)
      ? []
      : [target.label];
  });
  return (
    <SettingsSection id="model-evaluations" title="Zack · Model evaluations">
      <SettingsRow
        serverScoped
        settingKeys={["enableModelEvaluations"]}
        {...searchableSetting("blind-model-evaluations")}
        description={
          <>
            Use an extra model call to score completed tasks and build project guidance. Model and
            provider labels are removed before judging.
            {unavailableEnvironments.length > 0 ? (
              <span className="mt-1 block text-warning">
                Choose an available judge on {unavailableEnvironments.join(", ")} before enabling.
              </span>
            ) : null}
            {!supported ? (
              <span className="mt-1 block">
                Connect or update the selected environments to use this feature.
              </span>
            ) : null}
          </>
        }
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ScopedSwitch
              settingKeys={["enableModelEvaluations"]}
              checked={settings.enableModelEvaluations}
              disabled={
                !supported ||
                ((!settings.enableModelEvaluations || mixedEnabled) &&
                  unavailableEnvironments.length > 0)
              }
              onCheckedChange={(checked) => {
                if (!checked || unavailableEnvironments.length === 0)
                  updateSettings({ enableModelEvaluations: checked });
              }}
              aria-label="Blind model evaluations"
            />
            {mixedEnabled && unavailableEnvironments.length > 0 && supported ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => updateSettings({ enableModelEvaluations: false })}
              >
                Turn off for all
              </Button>
            ) : null}
          </div>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["modelEvaluationModelSelection"]}
        mixed={mixedJudge}
        {...searchableSetting("model-evaluation-judge")}
        description={
          <>
            Choose a judge, or use this environment's text generation model.
            {!mixedJudge && selectionIssue ? (
              <span className="mt-1 block text-warning">{selectionIssue}</span>
            ) : null}
          </>
        }
        control={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ProviderModelPicker
              environmentId={environment?.environmentId ?? null}
              activeInstanceId={selection.instanceId}
              model={selection.model}
              lockedProvider={null}
              instanceEntries={entries}
              modelOptionsByInstance={modelOptions}
              disabled={
                !supported ||
                !entries.some((candidate) => candidate.enabled && candidate.isAvailable)
              }
              getModelDisabledReason={disabledReason}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              triggerAriaLabel="Judge model"
              {...(mixedJudge
                ? { triggerLabel: "Mixed" }
                : selectionIssue
                  ? { triggerLabel: selection.model }
                  : {})}
              onInstanceModelChange={(instanceId, model) =>
                updateSettings({
                  modelEvaluationModelSelection: createModelSelection(instanceId, model),
                })
              }
            />
            {supported &&
            entry &&
            settings.modelEvaluationModelSelection !== null &&
            !mixedJudge ? (
              <TraitsPicker
                provider={entry.driverKind}
                models={entry.models}
                model={selection.model}
                modelOptions={selection.options ?? []}
                allowPromptInjectedEffort={false}
                planModeEnabled={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onModelOptionsChange={(options) =>
                  updateSettings({
                    modelEvaluationModelSelection: createModelSelection(
                      selection.instanceId,
                      selection.model,
                      options,
                    ),
                  })
                }
              />
            ) : null}
            {settings.modelEvaluationModelSelection !== null || mixedJudge ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={!supported}
                onClick={() => updateSettings({ modelEvaluationModelSelection: null })}
              >
                Use default
              </Button>
            ) : null}
          </div>
        }
      />
      {supportedEnvironments.map((target) => (
        <ProjectEvaluationBrowser
          key={target.environmentId}
          environmentId={target.environmentId}
          environmentLabel={target.label}
        />
      ))}
    </SettingsSection>
  );
}

function ProjectEvaluationBrowser(props: {
  environmentId: EnvironmentId;
  environmentLabel: string;
}) {
  const { targets, scope } = useSettingsScope();
  const projectScoped = scope.kind === "project" || scope.kind === "checkout";
  const scopedIds = new Set(
    targets
      .filter((target) => target.environmentId === props.environmentId)
      .map((target) => target.projectId),
  );
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === props.environmentId &&
      (!projectScoped || scopedIds.has(project.id)),
  );
  const [chosenProjectId, setChosenProjectId] = useState<ProjectId | null>(null);
  const project =
    (projectScoped && projects.length === 1
      ? projects[0]
      : projects.find((item) => item.id === chosenProjectId)) ?? null;
  return (
    <div className="space-y-3 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Learned guidance · {props.environmentLabel}</h3>
        <Select<ProjectId>
          value={project?.id ?? null}
          onValueChange={setChosenProjectId}
          disabled={projects.length === 0 || (projectScoped && projects.length === 1)}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-64"
            aria-label={`Evaluation project on ${props.environmentLabel}`}
          >
            <SelectValue>{project?.title ?? "Choose a project"}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {projects.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {project ? (
        <ProjectEvaluationReport
          key={project.id}
          environmentId={props.environmentId}
          projectId={project.id}
          projectTitle={project.title}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          Choose a project to view its evaluations and guidance.
        </p>
      )}
    </div>
  );
}

function ProjectEvaluationReport(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectTitle: string;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const query = useEnvironmentQuery(
    modelEvaluations.list({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const canClear = useAtomValue(modelEvaluations.clear.permissionAtom(props.environmentId));
  const clear = useAtomCommand(modelEvaluations.clear, { reportFailure: false });
  const [clearing, setClearing] = useState(false);
  const clearHistory = async () => {
    const message = `Clear model evaluations for ${props.projectTitle}?\nThis deletes this project's saved scores and learned guidance.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    setClearing(true);
    const result = await clear({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    });
    setClearing(false);
    if (result._tag === "Failure")
      toastManager.add({
        type: "error",
        title: "Could not clear evaluations",
        description: String(squashAtomCommandFailure(result)),
      });
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={query.isPending || clearing}
          onClick={query.refresh}
        >
          Refresh
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canClear || clearing || query.isPending || !query.data?.records.length}
          onClick={() => void clearHistory()}
        >
          {clearing ? "Clearing…" : "Clear project history"}
        </Button>
      </div>
      {query.error ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error}
        </p>
      ) : null}
      {query.isPending || clearing ? (
        <p className="text-sm text-muted-foreground">Loading evaluations…</p>
      ) : query.data && !query.error ? (
        <>
          <p className="text-xs text-muted-foreground">
            Up to {query.data.windowLimit} evaluations from the past 90 days. Scores use 0–4;
            unknown dimensions stay unscored. Small samples and judge opinions are advisory.
            {config?.settings.enableModelEvaluations === false
              ? " Evaluations are off; saved history is still available."
              : ""}
          </p>
          {query.data.records.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No evaluations yet. Complete a task with evaluations enabled to collect scores.
            </p>
          ) : null}
          {query.data.guidance.map((guidance) => (
            <GuidanceCard key={modelEvaluationGuidanceKey(guidance)} guidance={guidance} />
          ))}
          {query.data.records.length > 0 ? (
            <details className="rounded-md border p-3 text-sm">
              <summary className="cursor-pointer font-medium">
                Recent evaluations ({query.data.records.length})
              </summary>
              <ol className="mt-3 space-y-3">
                {query.data.records.map((record) => (
                  <li
                    key={record.runId}
                    className="space-y-1 border-t pt-3 first:border-0 first:pt-0"
                  >
                    <p className="break-words font-medium">
                      {modelEvaluationSelectionLabel(record.modelSelection)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {record.scope} · {record.status.replaceAll("_", " ")} ·{" "}
                      {new Date(record.at).toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Judge: {modelEvaluationSelectionLabel(record.evaluatorSelection)} ·{" "}
                      {record.rubricVersion}
                    </p>
                    {record.verdict ? (
                      <p className="text-xs">{record.verdict.rationale.text}</p>
                    ) : null}
                    {record.reason ? <p className="text-xs">{record.reason}</p> : null}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function GuidanceCard({ guidance }: { guidance: ModelEvaluationGuidance }) {
  return (
    <details className="rounded-md border p-3 text-sm">
      <summary className="cursor-pointer break-words font-medium">
        {modelEvaluationSelectionLabel(guidance.modelSelection)} · {guidance.taskCategory} ·{" "}
        {guidance.scope}
        <span className="ml-2 font-normal text-muted-foreground">
          {guidance.sampleCount} scored · {guidance.confidence}
        </span>
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">
          Judge: {modelEvaluationSelectionLabel(guidance.evaluatorSelection)} ·{" "}
          {guidance.rubricVersion}
        </p>
        <dl className="grid grid-cols-2 gap-3">
          {modelEvaluationScoreRows(guidance).map((score) => (
            <div key={score.key}>
              <dt className="text-xs text-muted-foreground">{score.label}</dt>
              <dd>
                {score.value}{" "}
                <span className="text-xs text-muted-foreground">({score.count} scored)</span>
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          {guidance.insufficientEvidenceCount} observations lacked sufficient evidence.
        </p>
        {guidance.sampleCount > 0 ? (
          <p className="text-xs text-muted-foreground">
            Observed prompt lengths: {guidance.promptChars.min.toLocaleString()}–
            {guidance.promptChars.max.toLocaleString()} characters (median{" "}
            {Math.round(guidance.promptChars.median).toLocaleString()}); this is not a
            context-window limit.
          </p>
        ) : null}
        <ObservationList title="Observed strengths" items={guidance.strengths} />
        <ObservationList title="Observed limitations" items={guidance.weaknesses} />
        <ObservationList title="Prompting guidance" items={guidance.promptAdvice} />
      </div>
    </details>
  );
}

function ObservationList({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className="text-xs font-medium">{title}</h4>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
