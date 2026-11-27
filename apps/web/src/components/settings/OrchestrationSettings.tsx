import {
  CUSTOM_ORCHESTRATION_COMMAND_NAME_PATTERN,
  CUSTOM_ORCHESTRATION_DESCRIPTION_MAX_LENGTH,
  CUSTOM_ORCHESTRATION_INSTRUCTIONS_MAX_LENGTH,
  CUSTOM_ORCHESTRATION_MAX_ENTRIES,
  CUSTOM_ORCHESTRATION_MAX_FALLBACKS,
  CUSTOM_ORCHESTRATION_NAME_MAX_LENGTH,
  customOrchestrationCommandNameProblem,
  type CustomOrchestrationCommand,
  type CustomOrchestrationModel,
  type CustomOrchestrationSettings,
  type CustomOrchestrationTask,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  customOrchestrationModelProblem,
  resolveCustomOrchestrationModel,
} from "@t3tools/shared/customOrchestration";
import { createModelSelection, pickModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import { PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  orchestrationModelName,
  orchestrationProblemText,
  useOrchestrationNow,
} from "../../customOrchestration";
import { cn, randomUUID } from "../../lib/utils";
import { getCustomModelOptionsByInstance, selectsPlanAgent } from "../../modelSelection";
import { isProviderInstancePickerReady, providerInstanceEntriesFor } from "../../providerInstances";
import { type EnvironmentPresentation, useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

// A long model id truncates on a phone, where it would otherwise cover the button beside it.
const TRIGGER_CLASSNAME = cn(SETTINGS_PICKER_TRIGGER_CLASSNAME, "max-w-full shrink");

export function OrchestrationSettingsPanel() {
  const setting = useSearchableSetting();
  const { environment } = useSettingsScope();
  const connected = environment?.connection.phase === "connected";
  if (connected && environment.serverConfig?.customOrchestration === true) {
    return (
      <SettingsPageContainer>
        <EnvironmentOrchestration key={environment.environmentId} environment={environment} />
      </SettingsPageContainer>
    );
  }
  return (
    <SettingsPageContainer>
      <SettingsSection {...setting("custom-orchestration")}>
        <p className="px-4 py-3 text-sm text-muted-foreground">
          {connected && environment.serverConfig !== null ? (
            <T>
              Update T3 Code on <Var>{environment.label}</Var> to use Custom Orchestration.
            </T>
          ) : (
            <T>Connect an environment to set up Custom Orchestration.</T>
          )}
        </p>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function EnvironmentOrchestration({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const setting = useSearchableSetting();
  const gt = useGT();
  const resolveMessage = useMessages();
  const navigate = useNavigate();
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const writable = useScopedSettingsWriteAllowed();
  const editable = writable && scope.kind !== "project" && scope.kind !== "checkout";
  const environmentId = environment.environmentId;
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(settings, providers);
  const config = settings.customOrchestration;
  const now = useOrchestrationNow(true);
  const problemOf = (selection: ModelSelection) =>
    customOrchestrationModelProblem(selection, { providers, now, settings });
  const save = (patch: Partial<CustomOrchestrationSettings>) =>
    updateSettings({ customOrchestration: { ...config, ...patch } });

  // What a new entry starts on: the orchestrator, else the first model a provider reports.
  const newSelection = ((): ModelSelection | null => {
    if (config.orchestrator !== null) return config.orchestrator.modelSelection;
    for (const entry of entries) {
      if (!isProviderInstancePickerReady(entry)) continue;
      const option = modelOptionsByInstance
        .get(entry.instanceId)
        ?.find((candidate) => !candidate.isUnavailable);
      if (option) return createModelSelection(entry.instanceId, option.slug);
    }
    return null;
  })();

  const modelControl = (
    selection: ModelSelection | null,
    label: string,
    onChange: (next: ModelSelection) => void,
  ): ReactNode => {
    const shown = selection ?? newSelection;
    if (shown === null) {
      return (
        <span className="text-sm text-muted-foreground">
          <T>No providers available.</T>
        </span>
      );
    }
    const entry = entries.find((candidate) => candidate.instanceId === shown.instanceId);
    const problem = selection === null ? null : problemOf(selection);
    // A model at its limit comes back by itself, so it keeps its name and effort.
    const unavailable = problem !== null && problem.kind !== "limit";
    return (
      <>
        <ProviderModelPicker
          environmentId={environmentId}
          activeInstanceId={shown.instanceId}
          model={shown.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={modelOptionsByInstance}
          triggerClassName={TRIGGER_CLASSNAME}
          triggerAriaLabel={label}
          // The picker would otherwise stand another model's name in for one it cannot find.
          {...(selection === null
            ? { triggerLabel: gt("Choose model") }
            : unavailable
              ? { triggerLabel: gt("{model} (Unavailable)", { model: selection.model }) }
              : {})}
          onOpenProviderSetup={(instanceId: ProviderInstanceId) => {
            void navigate({ to: "/settings/providers", search: { environmentId, instanceId } });
          }}
          onInstanceModelChange={(instanceId, model) =>
            onChange(pickModelSelection(selection, instanceId, model))
          }
        />
        {selection !== null && entry && !unavailable ? (
          <TraitsPicker
            provider={entry.driverKind}
            models={entry.models}
            model={selection.model}
            modelOptions={selection.options ?? []}
            allowPromptInjectedEffort={false}
            includePlanAgent={selectsPlanAgent(selection.options)}
            triggerClassName={TRIGGER_CLASSNAME}
            onModelOptionsChange={(options) =>
              onChange(createModelSelection(selection.instanceId, selection.model, options))
            }
          />
        ) : null}
      </>
    );
  };

  // The pickers wrap among themselves, so the remove button stays beside them on a narrow screen.
  const removableModel = (controls: ReactNode, remove: ReactNode, className = "") => (
    <div className={`flex min-w-0 items-center gap-2 ${className}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{controls}</div>
      {remove}
    </div>
  );

  /** What stands in for an unavailable model, or what happens when nothing can. */
  const modelStatus = (entry: CustomOrchestrationModel, nothingCanRun: string): string | null => {
    const { usable, skipped } = resolveCustomOrchestrationModel(entry, problemOf);
    const primary = skipped[0];
    if (primary?.selection !== entry.modelSelection) return null;
    const reason = orchestrationProblemText(
      primary.problem,
      orchestrationModelName(entries, primary.selection),
      resolveMessage,
    );
    const [standIn] = usable;
    const outcome = standIn
      ? gt("Using {model} for now.", { model: orchestrationModelName(entries, standIn) })
      : nothingCanRun;
    return `${reason} ${outcome}`;
  };

  const fallbackList = (
    entry: CustomOrchestrationModel,
    name: string,
    onChange: (fallbacks: ModelSelection[]) => void,
  ) => (
    <div className="space-y-2 ps-4">
      {entry.fallbacks.map((fallback, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- fallbacks have no identity besides their order
        <div key={index} className="flex flex-wrap items-center gap-2">
          <span className="me-auto text-xs text-muted-foreground">
            {gt("Fallback {number}", { number: index + 1 })}
          </span>
          {removableModel(
            modelControl(
              fallback,
              gt("Fallback {number} for {name}", { number: index + 1, name }),
              (next) => onChange(entry.fallbacks.map((other, at) => (at === index ? next : other))),
            ),
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={gt("Remove fallback {number} for {name}", { number: index + 1, name })}
              onClick={() => onChange(entry.fallbacks.filter((_, at) => at !== index))}
            >
              <XIcon className="size-3.5" />
            </Button>,
          )}
        </div>
      ))}
      {entry.fallbacks.length < CUSTOM_ORCHESTRATION_MAX_FALLBACKS
        ? addButton(gt("Add fallback"), entry.fallbacks.length, (fallback) =>
            onChange([...entry.fallbacks, fallback]),
          )
        : null}
    </div>
  );

  const updateTask = (id: string, patch: Partial<CustomOrchestrationTask>) =>
    save({ tasks: config.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task)) });
  const addTask = (modelSelection: ModelSelection) =>
    save({
      tasks: [
        ...config.tasks,
        {
          id: randomUUID(),
          name: gt("New task kind"),
          description: "",
          modelSelection,
          fallbacks: [],
        },
      ],
    });

  const updateCommand = (index: number, patch: Partial<CustomOrchestrationCommand>) =>
    save({
      commands: config.commands.map((command, at) =>
        at === index ? { ...command, ...patch } : command,
      ),
    });
  const updateReviewer = (
    index: number,
    reviewers: ReadonlyArray<CustomOrchestrationModel>,
    reviewerIndex: number,
    patch: Partial<CustomOrchestrationModel>,
  ) =>
    updateCommand(index, {
      reviewers: reviewers.map((other, at) =>
        at === reviewerIndex ? { ...other, ...patch } : other,
      ),
    });
  const addCommand = (modelSelection: ModelSelection) => {
    const taken = new Set(config.commands.map((command) => command.name));
    let name = "extreme-review";
    for (let suffix = 2; taken.has(name); suffix += 1) name = `extreme-review-${suffix}`;
    const reviewers = [{ modelSelection, fallbacks: [] }];
    save({ commands: [...config.commands, { name, instructions: "", reviewers }] });
  };
  const renameCommand = (index: number, value: string) => {
    const name = value.trim().replace(/^\/+/u, "");
    const problem = customOrchestrationCommandNameProblem(name);
    const reason =
      problem === "too-long" || name.length > CUSTOM_ORCHESTRATION_NAME_MAX_LENGTH
        ? gt("Use {count} characters or fewer.", { count: CUSTOM_ORCHESTRATION_NAME_MAX_LENGTH })
        : problem === "reserved"
          ? gt("/{name} is already a command.", { name })
          : problem === "format" || !CUSTOM_ORCHESTRATION_COMMAND_NAME_PATTERN.test(name)
            ? gt("Use lowercase letters, numbers, and hyphens.")
            : config.commands.some((command, at) => at !== index && command.name === name)
              ? gt("Another command already uses /{name}.", { name })
              : null;
    if (reason !== null) {
      toastManager.add({ type: "error", title: gt("Command not renamed"), description: reason });
      return;
    }
    updateCommand(index, { name });
  };

  function addButton(label: string, count: number, add: (selection: ModelSelection) => void) {
    return editable ? (
      <Button
        size="xs"
        variant="outline"
        disabled={newSelection === null || count >= CUSTOM_ORCHESTRATION_MAX_ENTRIES}
        onClick={() => {
          if (newSelection !== null) add(newSelection);
        }}
      >
        <PlusIcon className="size-3" aria-hidden />
        {label}
      </Button>
    ) : null;
  }

  return (
    <>
      <SettingsSection {...setting("custom-orchestration")}>
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          <T>
            Choose Custom Orchestration in the model picker to have the orchestrator delegate by
            these settings. A plain request for a review uses the orchestrator's own review command.
          </T>
        </p>
        <SettingsRow
          serverScoped
          settingKeys={["customOrchestration"]}
          title={gt("Orchestrator")}
          description={gt("The model that runs the thread and delegates the work.")}
          status={
            config.orchestrator === null
              ? null
              : modelStatus(
                  config.orchestrator,
                  gt("Messages send only once a configured model can run."),
                )
          }
          control={removableModel(
            modelControl(
              config.orchestrator?.modelSelection ?? null,
              gt("Orchestrator model"),
              (modelSelection) =>
                save({
                  orchestrator: {
                    modelSelection,
                    fallbacks: config.orchestrator?.fallbacks ?? [],
                  },
                }),
            ),
            config.orchestrator !== null ? (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={gt("Clear orchestrator")}
                onClick={() => save({ orchestrator: null })}
              >
                <XIcon className="size-3.5" />
              </Button>
            ) : null,
            "@min-[32rem]/settings-row:justify-end",
          )}
        >
          {config.orchestrator !== null ? (
            <div inert={!editable} className={editable ? "pt-2" : "pt-2 opacity-50"}>
              {fallbackList(config.orchestrator, gt("Orchestrator"), (fallbacks) => {
                if (config.orchestrator !== null) {
                  save({ orchestrator: { ...config.orchestrator, fallbacks } });
                }
              })}
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title={gt("Task kinds")}
        headerAction={addButton(gt("Add task kind"), config.tasks.length, addTask)}
      >
        {config.tasks.length === 0 ? (
          <SettingsRow
            title={gt("No task kinds yet.")}
            description={gt(
              "Add kinds of work, such as deep thinking or machine learning, and the model that should do each.",
            )}
          />
        ) : (
          <div inert={!editable} className={editable ? "divide-y" : "divide-y opacity-50"}>
            {config.tasks.map((task) => (
              <div key={task.id} className="space-y-2 px-3 py-3 sm:px-4">
                <div className="flex flex-wrap items-center gap-2">
                  <DraftInput
                    className="w-full sm:w-56"
                    aria-label={gt("Task kind name")}
                    maxLength={CUSTOM_ORCHESTRATION_NAME_MAX_LENGTH}
                    value={task.name}
                    onCommit={(value) => {
                      const name = value.trim();
                      if (name !== "") updateTask(task.id, { name });
                    }}
                  />
                  {removableModel(
                    modelControl(
                      task.modelSelection,
                      gt("Model for {task}", { task: task.name }),
                      (modelSelection) => updateTask(task.id, { modelSelection }),
                    ),
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={gt("Remove {task}", { task: task.name })}
                      onClick={() =>
                        save({ tasks: config.tasks.filter((other) => other.id !== task.id) })
                      }
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>,
                    "flex-1 justify-end",
                  )}
                </div>
                <DraftInput
                  aria-label={gt("When to use {task}", { task: task.name })}
                  placeholder={gt("When to use it, such as: architecture and hard debugging")}
                  maxLength={CUSTOM_ORCHESTRATION_DESCRIPTION_MAX_LENGTH}
                  value={task.description}
                  onCommit={(description) => updateTask(task.id, { description })}
                />
                {fallbackList(task, task.name, (fallbacks) => updateTask(task.id, { fallbacks }))}
                <p className="text-xs text-muted-foreground empty:hidden">
                  {modelStatus(task, gt("The orchestrator will say so and skip this work."))}
                </p>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title={gt("Review commands")}
        headerAction={addButton(gt("Add command"), config.commands.length, addCommand)}
      >
        {config.commands.length === 0 ? (
          <SettingsRow
            title={gt("No commands yet.")}
            description={gt(
              "A command such as /extreme-review has several models review the same work, then the orchestrator checks and merges their findings. Type it in a Custom Orchestration thread.",
            )}
          />
        ) : (
          <div inert={!editable} className={editable ? "divide-y" : "divide-y opacity-50"}>
            {config.commands.map((command, index) => (
              // Names are unique, and a rename remounting its own row loses nothing.
              <div key={command.name} className="space-y-2 px-3 py-3 sm:px-4">
                <div className="flex items-center gap-1.5">
                  <span aria-hidden className="text-sm text-muted-foreground">
                    /
                  </span>
                  <DraftInput
                    className="w-full sm:w-56"
                    aria-label={gt("Command name")}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={command.name}
                    onCommit={(value) => renameCommand(index, value)}
                  />
                  <Button
                    className="ms-auto"
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={gt("Remove /{name}", { name: command.name })}
                    onClick={() =>
                      save({ commands: config.commands.filter((_, at) => at !== index) })
                    }
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
                <Textarea
                  key={command.instructions}
                  aria-label={gt("Instructions for /{name}", { name: command.name })}
                  placeholder={gt("What the reviewers should look for (optional)")}
                  maxLength={CUSTOM_ORCHESTRATION_INSTRUCTIONS_MAX_LENGTH}
                  rows={2}
                  defaultValue={command.instructions}
                  onBlur={(event) => {
                    const instructions = event.currentTarget.value;
                    if (instructions !== command.instructions) {
                      updateCommand(index, { instructions });
                    }
                  }}
                />
                <h3 className="text-xs font-medium text-muted-foreground">
                  <T>Reviewers</T>
                </h3>
                {command.reviewers.map((reviewer, reviewerIndex) => {
                  const name = gt("Reviewer {number} of /{name}", {
                    number: reviewerIndex + 1,
                    name: command.name,
                  });
                  return (
                    // oxlint-disable-next-line react/no-array-index-key -- reviewers have no identity and may repeat a model
                    <div key={reviewerIndex} className="space-y-2">
                      {removableModel(
                        modelControl(reviewer.modelSelection, name, (modelSelection) =>
                          updateReviewer(index, command.reviewers, reviewerIndex, {
                            modelSelection,
                          }),
                        ),
                        command.reviewers.length > 1 ? (
                          <Button
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label={gt("Remove reviewer {number}", {
                              number: reviewerIndex + 1,
                            })}
                            onClick={() =>
                              updateCommand(index, {
                                reviewers: command.reviewers.filter(
                                  (_, at) => at !== reviewerIndex,
                                ),
                              })
                            }
                          >
                            <XIcon className="size-3.5" />
                          </Button>
                        ) : null,
                      )}
                      {fallbackList(reviewer, name, (fallbacks) =>
                        updateReviewer(index, command.reviewers, reviewerIndex, { fallbacks }),
                      )}
                      <p className="text-xs text-muted-foreground empty:hidden">
                        {modelStatus(reviewer, gt("The review will go on without this reviewer."))}
                      </p>
                    </div>
                  );
                })}
                {addButton(gt("Add reviewer"), command.reviewers.length, (modelSelection) =>
                  updateCommand(index, {
                    reviewers: [...command.reviewers, { modelSelection, fallbacks: [] }],
                  }),
                )}
              </div>
            ))}
          </div>
        )}
      </SettingsSection>
    </>
  );
}
