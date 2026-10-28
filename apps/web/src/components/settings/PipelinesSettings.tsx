import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import { dedupeProviderSkillsByName } from "@t3tools/client-runtime/providerSkills";
import {
  draftToUpsertInput,
  emptyPipelineDraft,
  hasPipelineDraftChanges,
  moveStep,
  newStepDraft,
  normalizeSkillName,
  PIPELINE_NAME_MAX_LENGTH,
  PIPELINE_STEP_SKILLS_MAX,
  type PipelineDraft,
  pipelineDraftIssues,
  type PipelineStepDefaults,
  type PipelineStepDraft,
  pipelineStepSummary,
  pipelineToDraft,
  starterToDraft,
} from "@t3tools/client-runtime/pipeline-editor";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ModelSelection,
  PIPELINE_MAX_STEPS,
  type PipelineDefinition,
  type ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  type ServerProviderSkill,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { PIPELINE_STARTERS, type PipelineStarter } from "@t3tools/shared/pipelineStarters";
import { AsyncResult } from "effect/reactivity";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { requestConfirmDialog } from "../../confirmDialog";
import { randomUUID } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
  providerInstanceEntriesFor,
} from "../../providerInstances";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { type EnvironmentPresentation, useEnvironment } from "../../state/environments";
import { formatEnvironmentQueryError } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { readEnvironmentScope } from "~/state/session";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { scheduledTaskDefaultModel } from "./scheduledTasksSettings.logic";

import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
} from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const TEMPLATE_VARIABLES_HINT =
  "Variables: {{input}} is the text the run starts with, {{previous.output}} the last message of the step before, {{steps.<id>.output}} an earlier step by id or name.";

function supportsPipelines(environment: EnvironmentPresentation): boolean {
  return (
    environment.connection.phase === "connected" &&
    environment.serverConfig?.environment.capabilities.pipelines === true
  );
}

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{hint}</span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}

export function PipelinesSettings() {
  const { scope, environments, connectedEnvironments, environment } = useSettingsScope();
  const [editor, setEditor] = useState<{
    environmentId: EnvironmentId;
    pipeline: PipelineDefinition | null;
    starter: PipelineStarter | null;
  } | null>(null);
  const inScope = (entry: EnvironmentPresentation) =>
    scope.kind !== "unavailable" && scope.environmentIds.includes(entry.environmentId);
  const scopedEnvironments = environments.filter(inScope);
  const capableEnvironments = connectedEnvironments.filter(
    (entry) => inScope(entry) && supportsPipelines(entry),
  );
  const defaultEnvironment =
    environment && inScope(environment) && supportsPipelines(environment)
      ? environment
      : capableEnvironments[0];
  const canCreate = useAtomValue(
    serverEnvironment.upsertPipeline.permissionAtom(defaultEnvironment?.environmentId ?? null),
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Pipelines"
        variant="plain"
        headerAction={
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={!defaultEnvironment || !canCreate}
                />
              }
            >
              <PlusIcon className="size-3" />
              New pipeline
              <ChevronDownIcon className="size-3" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                onClick={() =>
                  defaultEnvironment &&
                  setEditor({
                    environmentId: defaultEnvironment.environmentId,
                    pipeline: null,
                    starter: null,
                  })
                }
              >
                Blank pipeline
              </MenuItem>
              {PIPELINE_STARTERS.map((starter) => (
                <MenuItem
                  key={starter.key}
                  onClick={() =>
                    defaultEnvironment &&
                    setEditor({
                      environmentId: defaultEnvironment.environmentId,
                      pipeline: null,
                      starter,
                    })
                  }
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{starter.name}</div>
                    <div className="text-muted-foreground">{starter.description}</div>
                  </div>
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        }
      >
        {scope.kind === "unavailable" ? (
          <SettingsSection title="Unavailable selection">
            <SettingsRow title={scope.message} />
          </SettingsSection>
        ) : scopedEnvironments.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <WorkflowIcon />
              </EmptyMedia>
              <EmptyTitle>No environments available</EmptyTitle>
              <EmptyDescription>Connect an environment to manage pipelines.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <PipelinesEnvironmentList
            environments={scopedEnvironments}
            onEdit={(environmentId, pipeline) =>
              setEditor({ environmentId, pipeline, starter: null })
            }
          />
        )}
      </SettingsSection>
      {editor ? (
        <PipelineEditorDialog
          key={editor.pipeline?.id ?? editor.starter?.key ?? "new"}
          environmentId={editor.environmentId}
          pipeline={editor.pipeline}
          starter={editor.starter}
          capableEnvironments={capableEnvironments}
          onEnvironmentChange={(environmentId) =>
            setEditor({ environmentId, pipeline: null, starter: editor.starter })
          }
          onClose={() => setEditor(null)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

const pipelinesListAtom = environmentAtomList("web-pipelines-list", (environmentId) =>
  serverEnvironment.pipelinesLive({ environmentId, input: {} }),
);

function PipelinesEnvironmentList({
  environments,
  onEdit,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly onEdit: (environmentId: EnvironmentId, pipeline: PipelineDefinition) => void;
}) {
  // Only environments that answer pipelines.* are subscribed; the rest get a note instead.
  const subscribedIds = environments.flatMap((entry) =>
    supportsPipelines(entry) ? [entry.environmentId] : [],
  );
  const queries = useAtomValue(pipelinesListAtom(environmentIdsKey(subscribedIds)));
  const showEnvironmentTitle = environments.length > 1;

  return (
    <div className="space-y-8">
      {environments.map((entry) => {
        const index = subscribedIds.indexOf(entry.environmentId);
        const query = index < 0 ? null : queries[index]!;
        const data = query === null ? null : AsyncResult.getOrElse(query, () => null);
        return (
          <SettingsSection
            key={entry.environmentId}
            title={entry.label}
            hideTitle={!showEnvironmentTitle}
            icon={
              <EnvironmentMachineIcon
                kind={resolveEnvironmentMachineKind(entry.serverConfig)}
                className="size-3.5"
              />
            }
          >
            {entry.connection.phase !== "connected" || entry.serverConfig === null ? (
              <SettingsRow
                title="Environment disconnected"
                description={`Reconnect ${entry.label} to view its pipelines (${connectionStatusTitle(entry.connection)}).`}
              />
            ) : !supportsPipelines(entry) ? (
              <SettingsRow
                title="Update this server to use pipelines"
                description={`The T3 Code server on ${entry.label} is too old to run pipelines. Update it, then reload.`}
                role="status"
              />
            ) : query?._tag === "Failure" ? (
              <SettingsRow
                title="Could not load pipelines"
                description={formatEnvironmentQueryError(query.cause)}
              />
            ) : !data ? (
              <SettingsRow title="Loading pipelines…" role="status" />
            ) : data.pipelines.length === 0 ? (
              <SettingsRow
                title="No pipelines"
                description="Chain agent steps, each with its own model and prompt, and start the whole run from a new thread."
              />
            ) : (
              data.pipelines.map((pipeline) => (
                <PipelineRow
                  key={pipeline.id}
                  environmentId={entry.environmentId}
                  pipeline={pipeline}
                  onEdit={() => onEdit(entry.environmentId, pipeline)}
                />
              ))
            )}
          </SettingsSection>
        );
      })}
    </div>
  );
}

function PipelineRow({
  environmentId,
  pipeline,
  onEdit,
}: {
  readonly environmentId: EnvironmentId;
  readonly pipeline: PipelineDefinition;
  readonly onEdit: () => void;
}) {
  const canEdit = useAtomValue(serverEnvironment.upsertPipeline.permissionAtom(environmentId));
  const canDelete = useAtomValue(serverEnvironment.deletePipeline.permissionAtom(environmentId));
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const [busy, setBusy] = useState(false);
  const remove = useAtomCommand(serverEnvironment.deletePipeline, {
    label: "pipeline delete",
    reportFailure: false,
  });
  const summary = pipelineStepSummary(pipeline.steps, (selection) => {
    const entry = deriveProviderInstanceEntries(providers).find(
      (candidate) => candidate.instanceId === selection.instanceId,
    );
    const model = entry?.models.find((candidate) => candidate.slug === selection.model);
    return model ? (model.shortName ?? model.name) : selection.model;
  });

  const confirmDelete = async () => {
    if (busy || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
    const message = `Delete "${pipeline.name}"?\nRuns already started keep their own copy of the steps.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    setBusy(true);
    const result = await remove({ environmentId, input: { id: pipeline.id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not delete pipeline", squashAtomCommandFailure(result));
    }
  };

  return (
    <SettingsRow
      title={pipeline.name}
      description={<span className="line-clamp-2">{summary}</span>}
      status={
        <Badge variant="outline">
          {pipeline.steps.length} {pipeline.steps.length === 1 ? "step" : "steps"}
        </Badge>
      }
      control={
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={busy || !canEdit}
            aria-label={`Edit ${pipeline.name}`}
            onClick={onEdit}
          >
            <PencilIcon className="size-4" />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={busy || !canDelete}
            aria-label={`Delete ${pipeline.name}`}
            onClick={() => void confirmDelete()}
          >
            <Trash2Icon className="size-4" />
          </Button>
        </div>
      }
    />
  );
}

function PipelineEditorDialog({
  environmentId,
  pipeline,
  starter,
  capableEnvironments,
  onEnvironmentChange,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly pipeline: PipelineDefinition | null;
  readonly starter: PipelineStarter | null;
  readonly capableEnvironments: ReadonlyArray<EnvironmentPresentation>;
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
  readonly onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const environment = useEnvironment(environmentId);
  const connected = environment !== null && supportsPipelines(environment);
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canOperate = useAtomValue(serverEnvironment.upsertPipeline.permissionAtom(environmentId));
  const upsertPipeline = useAtomCommand(serverEnvironment.upsertPipeline, {
    label: "pipeline upsert",
    reportFailure: false,
  });
  const instanceEntries = providerInstanceEntriesFor(providers, settings, null);
  const defaults: PipelineStepDefaults = {
    modelSelection: scheduledTaskDefaultModel(settings, null, instanceEntries),
    runtimeMode: settings.defaultRuntimeMode,
  };
  const [baseline, setBaseline] = useState<PipelineDraft>(() =>
    pipeline
      ? pipelineToDraft(pipeline, randomUUID)
      : starter
        ? starterToDraft(starter, randomUUID, defaults.runtimeMode)
        : emptyPipelineDraft(defaults, randomUUID),
  );
  const [draft, setDraft] = useState<PipelineDraft>(baseline);
  // Another environment has other providers, so only the model choices start over; the baseline
  // follows so switching alone is not an unsaved change.
  const [draftEnvironmentId, setDraftEnvironmentId] = useState(environmentId);
  if (draftEnvironmentId !== environmentId) {
    setDraftEnvironmentId(environmentId);
    setBaseline(withDefaultModel(baseline, defaults.modelSelection));
    setDraft(withDefaultModel(draft, defaults.modelSelection));
  }
  const submissionPending = useRef(false);
  const issues = pipelineDraftIssues(draft);
  const canSubmit = issues.valid && connected && canOperate && !saving;

  const updateStep = (key: string, patch: Partial<PipelineStepDraft>) =>
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step) => (step.key === key ? { ...step, ...patch } : step)),
    }));

  const requestClose = async () => {
    if (saving) return;
    if (hasPipelineDraftChanges(baseline, draft)) {
      const message = "Discard your changes to this pipeline?";
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return;
    }
    onClose();
  };

  const submit = async () => {
    const input = draftToUpsertInput(draft);
    if (
      input === null ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      submissionPending.current ||
      !connected
    )
      return;
    // Lock before React renders, and keep successful saves locked until the form closes.
    submissionPending.current = true;
    setSaving(true);
    const result = await upsertPipeline({ environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      submissionPending.current = false;
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not save pipeline", squashAtomCommandFailure(result));
      }
      return;
    }
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void requestClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{pipeline ? "Edit pipeline" : "New pipeline"}</DialogTitle>
          <DialogDescription>
            Run steps one after another, each in its own thread with its own model and prompt.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          {/* Fieldsets default to min-width: min-content, which lets one wide control widen the form past the dialog. */}
          <fieldset disabled={saving} className="min-w-0 space-y-5">
            {!connected ? (
              <p className="text-sm text-destructive">
                Reconnect this environment, on a server that supports pipelines, before saving.
              </p>
            ) : null}
            {capableEnvironments.length > 1 ? (
              <Field label="Runs on" htmlFor="pipeline-environment">
                <Select
                  value={environmentId}
                  disabled={pipeline !== null || saving}
                  onValueChange={(id) => {
                    const next = capableEnvironments.find((entry) => entry.environmentId === id);
                    if (next) onEnvironmentChange(next.environmentId);
                  }}
                >
                  <SelectTrigger id="pipeline-environment" size="sm">
                    <SelectValue>{environment?.label ?? "Unavailable environment"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {capableEnvironments.map((entry) => (
                      <SelectItem
                        key={entry.environmentId}
                        value={entry.environmentId}
                        label={entry.label}
                      >
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
            ) : null}
            <Field label="Name" htmlFor="pipeline-name">
              <Input
                id="pipeline-name"
                placeholder="e.g. Plan, implement, review"
                maxLength={PIPELINE_NAME_MAX_LENGTH}
                aria-invalid={issues.name !== null && draft.name.length > 0 ? true : undefined}
                value={draft.name}
                onChange={(event) => {
                  const name = event.target.value;
                  setDraft((current) => ({ ...current, name }));
                }}
              />
            </Field>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <Label>
                  Steps{" "}
                  <span className="font-normal text-muted-foreground">
                    ({draft.steps.length}/{PIPELINE_MAX_STEPS})
                  </span>
                </Label>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={draft.steps.length >= PIPELINE_MAX_STEPS}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      steps: [...current.steps, newStepDraft(current.steps, defaults, randomUUID)],
                    }))
                  }
                >
                  <PlusIcon />
                  Add step
                </Button>
              </div>
              {issues.stepCount ? (
                <p className="text-xs text-destructive" role="status">
                  {issues.stepCount}
                </p>
              ) : null}
              {draft.steps.map((step, index) => (
                <PipelineStepEditor
                  key={step.key}
                  environmentId={environmentId}
                  step={step}
                  index={index}
                  count={draft.steps.length}
                  issues={issues.steps.get(step.key) ?? []}
                  instanceEntries={instanceEntries}
                  providers={providers}
                  settings={settings}
                  disabled={saving || !connected}
                  onChange={(patch) => updateStep(step.key, patch)}
                  onMove={(delta) =>
                    setDraft((current) => ({
                      ...current,
                      steps: moveStep(current.steps, index, delta),
                    }))
                  }
                  onRemove={() =>
                    setDraft((current) => ({
                      ...current,
                      steps: current.steps.filter((entry) => entry.key !== step.key),
                    }))
                  }
                />
              ))}
            </div>
          </fieldset>
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" size="sm" disabled={saving} onClick={() => void requestClose()}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSubmit} onClick={() => void submit()}>
            {pipeline ? "Save pipeline" : "Create pipeline"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function withDefaultModel(draft: PipelineDraft, modelSelection: ModelSelection | null) {
  return {
    ...draft,
    steps: draft.steps.map((step) => ({ ...step, modelSelection })),
  };
}

function PipelineStepEditor({
  environmentId,
  step,
  index,
  count,
  issues,
  instanceEntries,
  providers,
  settings,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  readonly environmentId: EnvironmentId;
  readonly step: PipelineStepDraft;
  readonly index: number;
  readonly count: number;
  readonly issues: ReadonlyArray<string>;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly disabled: boolean;
  readonly onChange: (patch: Partial<PipelineStepDraft>) => void;
  readonly onMove: (delta: -1 | 1) => void;
  readonly onRemove: () => void;
}) {
  const selection = step.modelSelection;
  const activeEntry = selection
    ? (instanceEntries.find((entry) => entry.instanceId === selection.instanceId) ?? null)
    : null;
  const activeInstanceId =
    selection?.instanceId ?? instanceEntries[0]?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = selection?.model ?? "";
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    activeModel,
  );
  const setModel = (next: ModelSelection) => onChange({ modelSelection: next });
  const idPrefix = `pipeline-step-${step.key}`;

  return (
    <div className="space-y-4 rounded-lg border border-border p-3" data-step-index={index}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">Step {index + 1}</span>
        <div className="flex items-center gap-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={disabled || index === 0}
            aria-label={`Move step ${index + 1} up`}
            onClick={() => onMove(-1)}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={disabled || index === count - 1}
            aria-label={`Move step ${index + 1} down`}
            onClick={() => onMove(1)}
          >
            <ArrowDownIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={disabled || count <= 1}
            aria-label={`Remove step ${index + 1}`}
            onClick={onRemove}
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>

      <Field label="Name" htmlFor={`${idPrefix}-name`}>
        <Input
          id={`${idPrefix}-name`}
          placeholder="e.g. Plan"
          maxLength={PIPELINE_NAME_MAX_LENGTH}
          value={step.name}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </Field>

      <Field label="Model">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <ProviderModelPicker
            environmentId={environmentId}
            disabled={disabled}
            activeInstanceId={activeInstanceId}
            model={activeModel}
            lockedProvider={null}
            instanceEntries={instanceEntries}
            modelOptionsByInstance={modelOptionsByInstance}
            isComposerOwned={false}
            triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
            onInstanceModelChange={(instanceId, model) =>
              setModel(createModelSelection(instanceId, model))
            }
          />
          {selection && activeEntry ? (
            <TraitsPicker
              provider={activeEntry.driverKind}
              instanceId={selection.instanceId}
              models={activeEntry.models}
              model={selection.model}
              modelOptions={selection.options ?? []}
              allowPromptInjectedEffort={false}
              planModeEnabled={false}
              disabled={disabled}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              onModelOptionsChange={(options) =>
                setModel(createModelSelection(selection.instanceId, selection.model, options))
              }
            />
          ) : selection ? (
            <span className="text-xs text-muted-foreground">
              This provider is unavailable here. Pick another model.
            </span>
          ) : null}
        </div>
      </Field>

      <Field label="Permissions" htmlFor={`${idPrefix}-runtime`}>
        <Select
          value={step.runtimeMode}
          onValueChange={(value) => {
            if (value) onChange({ runtimeMode: value as RuntimeMode });
          }}
        >
          <SelectTrigger size="sm" id={`${idPrefix}-runtime`}>
            <SelectValue>{runtimeModeConfig[step.runtimeMode].label}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {runtimeModeOptions.map((mode) => {
              const option = runtimeModeConfig[mode];
              const Icon = option.icon;
              return (
                <SelectItem key={mode} value={mode} className="min-w-64">
                  <div className="grid gap-0.5">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      {option.label}
                    </span>
                    <span className="text-xs leading-4 text-muted-foreground">
                      {option.description}
                    </span>
                  </div>
                </SelectItem>
              );
            })}
          </SelectPopup>
        </Select>
      </Field>

      <StepSkillsField
        idPrefix={idPrefix}
        skills={step.skills}
        available={activeEntry?.snapshot.skills ?? []}
        disabled={disabled}
        onChange={(skills) => onChange({ skills })}
      />

      <Field label="Prompt" htmlFor={`${idPrefix}-template`}>
        <Textarea
          id={`${idPrefix}-template`}
          className="max-h-64 overflow-y-auto"
          placeholder="What should this step do?"
          value={step.promptTemplate}
          onChange={(event) => onChange({ promptTemplate: event.target.value })}
        />
        <p className="text-xs text-muted-foreground">{TEMPLATE_VARIABLES_HINT}</p>
      </Field>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${idPrefix}-pause`}>Pause before this step</Label>
          <p className="text-sm text-muted-foreground">
            The run waits for you to continue before this step starts.
          </p>
        </div>
        <Switch
          id={`${idPrefix}-pause`}
          checked={step.pauseBefore}
          onCheckedChange={(pauseBefore) => onChange({ pauseBefore })}
        />
      </div>

      {issues.length > 0 ? (
        <ul className="space-y-1 text-xs text-destructive" role="status">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Skills of the step's provider are offered as suggestions; any valid name can be typed. */
function StepSkillsField({
  idPrefix,
  skills,
  available,
  disabled,
  onChange,
}: {
  readonly idPrefix: string;
  readonly skills: ReadonlyArray<string>;
  readonly available: ReadonlyArray<ServerProviderSkill>;
  readonly disabled: boolean;
  readonly onChange: (skills: ReadonlyArray<string>) => void;
}) {
  const [text, setText] = useState("");
  const suggestions = dedupeProviderSkillsByName(available.filter((skill) => skill.enabled))
    .map((skill) => skill.name)
    .filter((name) => normalizeSkillName(name) === name && !skills.includes(name));
  const normalized = text.trim() ? normalizeSkillName(text) : null;
  const full = skills.length >= PIPELINE_STEP_SKILLS_MAX;
  const add = () => {
    if (normalized === null || full) return;
    if (!skills.includes(normalized)) onChange([...skills, normalized]);
    setText("");
  };

  return (
    <Field label="Skills" hint={`optional, up to ${PIPELINE_STEP_SKILLS_MAX}`}>
      {skills.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {skills.map((skill) => (
            <Badge key={skill} variant="outline">
              ${skill}
              <button
                type="button"
                className="rounded-sm text-muted-foreground hover:text-foreground"
                disabled={disabled}
                aria-label={`Remove skill ${skill}`}
                onClick={() => onChange(skills.filter((entry) => entry !== skill))}
              >
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          nativeInput
          size="sm"
          list={`${idPrefix}-skills`}
          aria-label="Add skill"
          placeholder={suggestions.length > 0 ? "Pick or type a skill name" : "Type a skill name"}
          disabled={disabled || full}
          aria-invalid={text.trim() && normalized === null ? true : undefined}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // Enter adds the skill; it must not submit or close the dialog.
            event.preventDefault();
            add();
          }}
        />
        <datalist id={`${idPrefix}-skills`}>
          {suggestions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || full || normalized === null}
          onClick={add}
        >
          Add
        </Button>
      </div>
    </Field>
  );
}
