import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProjectScript,
  type ProjectScriptIcon,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { createModelSelection } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import {
  BugIcon,
  FlaskConicalIcon,
  HammerIcon,
  ListChecksIcon,
  PlayIcon,
  WrenchIcon,
} from "lucide-react";
import React, {
  type FormEvent,
  type KeyboardEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  keybindingValueForCommand,
  decodeProjectScriptKeybindingRule,
} from "~/lib/projectScriptKeybindings";
import { keybindingFromKeyboardEvent } from "~/components/settings/KeybindingsSettings.logic";
import { commandForProjectScript, nextProjectScriptId } from "~/projectScripts";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelectionFromEntries,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { readPromptUltrathink, TraitsPicker } from "./chat/TraitsPicker";
import { useComposerMenuState } from "./chat/useComposerMenuState";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "./ui/select";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";

const SCRIPT_ICONS: Array<{ id: ProjectScriptIcon; label: string }> = [
  { id: "play", label: "Play" },
  { id: "test", label: "Test" },
  { id: "lint", label: "Lint" },
  { id: "configure", label: "Configure" },
  { id: "build", label: "Build" },
  { id: "debug", label: "Debug" },
];

export function ScriptIcon({
  icon,
  className = "size-3.5",
}: {
  icon: ProjectScriptIcon;
  className?: string;
}) {
  if (icon === "test") return <FlaskConicalIcon className={className} />;
  if (icon === "lint") return <ListChecksIcon className={className} />;
  if (icon === "configure") return <WrenchIcon className={className} />;
  if (icon === "build") return <HammerIcon className={className} />;
  if (icon === "debug") return <BugIcon className={className} />;
  return <PlayIcon className={className} />;
}

export interface NewProjectScriptInput {
  name: string;
  type?: "shell" | "prompt";
  prompt?: string;
  modelSelection?: ModelSelection | null;
  command: string;
  icon: ProjectScriptIcon;
  runOnWorktreeCreate: boolean;
  waitForSetup: boolean;
  runOnSettle: boolean;
  /** Omit to preserve the current shortcut when the form did not edit it. */
  keybinding?: string | null;
  previewUrl: string | null;
  autoOpenPreview: boolean;
}

export type ProjectScriptActionResult = AtomCommandResult<void, unknown>;

export const EMPTY_PROJECT_SCRIPT_INPUT: NewProjectScriptInput = {
  name: "",
  command: "",
  icon: "play",
  runOnWorktreeCreate: false,
  waitForSetup: false,
  runOnSettle: false,
  keybinding: null,
  previewUrl: null,
  autoOpenPreview: false,
};

export interface ProjectScriptEditorRequest {
  scriptId: string | null;
  initial: NewProjectScriptInput;
  error?: string;
}

export function editorRequestForScript(
  script: ProjectScript,
  keybindings: ResolvedKeybindingsConfig,
): ProjectScriptEditorRequest {
  return {
    scriptId: script.id,
    initial: {
      name: script.name,
      type: script.type ?? "shell",
      prompt: script.type === "prompt" ? script.prompt : "",
      modelSelection: script.type === "prompt" ? (script.modelSelection ?? null) : null,
      command: script.type === "prompt" ? "" : script.command,
      icon: script.icon,
      runOnWorktreeCreate: script.runOnWorktreeCreate,
      waitForSetup: script.runOnWorktreeCreate && script.async === false,
      runOnSettle: script.runOnSettle ?? false,
      keybinding: keybindingValueForCommand(keybindings, commandForProjectScript(script.id)),
      previewUrl: script.previewUrl ?? null,
      autoOpenPreview: script.autoOpenPreview ?? false,
    },
  };
}

export function ProjectScriptEditorDialog({
  environmentId,
  editScope = AuthOrchestrationOperateScope,
  projectId,
  request,
  scripts,
  onSubmit,
  onDelete,
  onClose,
}: {
  environmentId: EnvironmentId;
  editScope?: typeof AuthOrchestrationOperateScope | typeof AuthSettingsWriteScope;
  projectId: ProjectId | null;
  request: ProjectScriptEditorRequest | null;
  scripts: ReadonlyArray<ProjectScript>;
  onSubmit: (
    scriptId: string | null,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDelete: (scriptId: string) => void;
  onClose: () => void;
}) {
  const canEditActions = useEnvironmentScope(environmentId, editScope);
  // Keyed by the request it belongs to: a new request starts from its own error,
  // and a late save from the previous request can't overwrite it.
  const [errorState, setErrorState] = useState<{
    readonly request: ProjectScriptEditorRequest;
    readonly message: string | null;
  } | null>(null);
  const validationError =
    request === null
      ? null
      : errorState?.request === request
        ? errorState.message
        : (request.error ?? null);
  const setValidationError = (message: string | null) => {
    if (request !== null) setErrorState({ request, message });
  };
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useComposerMenuState(!canEditActions);
  const [deleteName, setDeleteName] = useState("");

  return (
    <>
      <Dialog
        open={request !== null}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        {/* The form owns its fields so a keystroke re-renders it, not the dialog chrome. */}
        <DialogPopup>
          <ProjectScriptEditorForm
            environmentId={environmentId}
            editScope={editScope}
            projectId={projectId}
            request={request}
            scripts={scripts}
            validationError={validationError}
            onValidationError={setValidationError}
            onSubmit={onSubmit}
            onRequestDelete={(name) => {
              setDeleteName(name);
              setDeleteConfirmOpen(true);
            }}
            onClose={onClose}
          />
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen && canEditActions} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete action "{deleteName}"?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={!canEditActions}
              onClick={() => {
                if (!request?.scriptId) return;
                if (!readEnvironmentScope(environmentId, editScope)) {
                  setValidationError("This connection cannot change project actions.");
                  return;
                }
                setDeleteConfirmOpen(false);
                onClose();
                onDelete(request.scriptId);
              }}
            >
              Delete action
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function ProjectScriptEditorForm({
  environmentId,
  editScope,
  projectId,
  request,
  scripts,
  validationError,
  onValidationError: setValidationError,
  onSubmit,
  onRequestDelete,
  onClose,
}: {
  environmentId: EnvironmentId;
  editScope: typeof AuthOrchestrationOperateScope | typeof AuthSettingsWriteScope;
  projectId: ProjectId | null;
  request: ProjectScriptEditorRequest | null;
  scripts: ReadonlyArray<ProjectScript>;
  validationError: string | null;
  onValidationError: (error: string | null) => void;
  onSubmit: (
    scriptId: string | null,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onRequestDelete: (name: string) => void;
  onClose: () => void;
}) {
  const canEditActions = useEnvironmentScope(environmentId, editScope);
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const formId = React.useId();
  const [name, setName] = useState("");
  const [actionType, setActionType] = useState<"shell" | "prompt">("shell");
  const [prompt, setPrompt] = useState("");
  const [command, setCommand] = useState("");
  const [icon, setIcon] = useState<ProjectScriptIcon>("play");
  const [iconPickerOpen, setIconPickerOpen] = useComposerMenuState(!canEditActions);
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(false);
  const [waitForSetup, setWaitForSetup] = useState(false);
  const [runOnSettle, setRunOnSettle] = useState(false);
  const [keybinding, setKeybinding] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [autoOpenPreview, setAutoOpenPreview] = useState(false);
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
  const [savingRequest, setSavingRequest] = useState<ProjectScriptEditorRequest | null>(null);
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, projectId),
  );
  const fallbackModelSelection =
    resolveDefaultProviderModelSelectionFromEntries(
      instanceEntries,
      settings.defaultModelSelection,
    ) ??
    instanceEntries.reduce<ModelSelection | null>((selection, entry) => {
      if (selection || !entry.enabled || !entry.models[0]) return selection;
      return createModelSelection(entry.instanceId, entry.models[0].slug);
    }, null);
  const effectiveModelSelection = modelSelection ?? fallbackModelSelection;
  const activeEntry =
    instanceEntries.find((entry) => entry.instanceId === effectiveModelSelection?.instanceId) ??
    null;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    effectiveModelSelection?.instanceId,
    effectiveModelSelection?.model,
  );
  const pendingSubmissionRef = useRef<{ request: ProjectScriptEditorRequest } | null>(null);

  const isEditing = request?.scriptId != null;
  const isSaving = request !== null && savingRequest === request;

  useLayoutEffect(
    () => () => {
      if (pendingSubmissionRef.current?.request === request) {
        pendingSubmissionRef.current = null;
      }
    },
    [request],
  );

  const [formRequest, setFormRequest] = useState<ProjectScriptEditorRequest | null>(null);
  if (request !== formRequest) {
    setFormRequest(request);
    if (request) {
      setName(request.initial.name);
      setActionType(request.initial.type ?? "shell");
      setPrompt(request.initial.prompt ?? "");
      setCommand(request.initial.command);
      setIcon(request.initial.icon);
      setIconPickerOpen(false);
      setRunOnWorktreeCreate(request.initial.runOnWorktreeCreate);
      setWaitForSetup(request.initial.waitForSetup);
      setRunOnSettle(request.initial.runOnSettle);
      setKeybinding(request.initial.keybinding ?? "");
      setPreviewUrl(request.initial.previewUrl ?? "");
      setAutoOpenPreview(request.initial.autoOpenPreview);
      setModelSelection(request.initial.modelSelection ?? null);
      setSavingRequest(null);
    }
  }

  const close = () => {
    pendingSubmissionRef.current = null;
    setSavingRequest(null);
    setIconPickerOpen(false);
    onClose();
  };

  const captureKeybinding = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!readEnvironmentScope(environmentId, editScope)) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return;
    if (event.key === "Tab") return;
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      setKeybinding("");
      return;
    }
    const next = keybindingFromKeyboardEvent(event, navigator.platform);
    if (!next) return;
    setKeybinding(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!request || pendingSubmissionRef.current !== null) return;
    if (!readEnvironmentScope(environmentId, editScope)) {
      setValidationError("This connection cannot change project actions.");
      return;
    }
    const changesKeybinding =
      (keybinding.trim() || null) !== (request.initial.keybinding?.trim() || null);
    const canChangeKeybinding = readEnvironmentScope(environmentId, AuthSettingsWriteScope);
    if (changesKeybinding && !canChangeKeybinding) {
      setValidationError("This connection cannot change keyboard shortcuts.");
      return;
    }
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (trimmedName.length === 0) {
      setValidationError("Name is required.");
      return;
    }
    if ((actionType === "prompt" ? prompt.trim() : trimmedCommand).length === 0) {
      setValidationError(actionType === "prompt" ? "Prompt is required." : "Command is required.");
      return;
    }

    setValidationError(null);
    let payload: NewProjectScriptInput;
    try {
      const scriptIdForValidation =
        request.scriptId ??
        nextProjectScriptId(
          trimmedName,
          scripts.map((script) => script.id),
        );
      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding,
        command: commandForProjectScript(scriptIdForValidation),
      });
      const trimmedPreviewUrl = previewUrl.trim();
      payload = {
        type: actionType,
        prompt: prompt.trim(),
        ...(actionType === "prompt" && modelSelection ? { modelSelection } : {}),
        name: trimmedName,
        command: trimmedCommand,
        icon,
        runOnWorktreeCreate,
        waitForSetup: runOnWorktreeCreate && waitForSetup,
        runOnSettle,
        ...((request.scriptId === null && canChangeKeybinding) || changesKeybinding
          ? { keybinding: keybindingRule?.key ?? null }
          : {}),
        previewUrl: trimmedPreviewUrl.length > 0 ? trimmedPreviewUrl : null,
        autoOpenPreview: trimmedPreviewUrl.length > 0 ? autoOpenPreview : false,
      } satisfies NewProjectScriptInput;
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : "Failed to save action.");
      return;
    }

    const submission = { request };
    pendingSubmissionRef.current = submission;
    setSavingRequest(request);
    setIconPickerOpen(false);
    try {
      const result = await onSubmit(request.scriptId, payload);
      if (pendingSubmissionRef.current === submission) {
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            setValidationError(error instanceof Error ? error.message : "Failed to save action.");
          }
        } else {
          close();
        }
      }
    } catch (error) {
      if (pendingSubmissionRef.current === submission) {
        setValidationError(error instanceof Error ? error.message : "Failed to save action.");
      }
    }
    if (pendingSubmissionRef.current === submission) {
      pendingSubmissionRef.current = null;
      setSavingRequest(null);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isEditing ? "Edit Action" : "Add Action"}</DialogTitle>
        <DialogDescription>
          Actions are project-scoped shell scripts or prompts you can run from the top bar or
          keybindings.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form id={formId} onSubmit={submit}>
          <fieldset className="space-y-4" disabled={isSaving || !canEditActions}>
            <div className="space-y-1.5">
              <Label htmlFor="script-name">Name</Label>
              <div className="flex items-center gap-2">
                <Popover onOpenChange={setIconPickerOpen} open={iconPickerOpen}>
                  <PopoverTrigger
                    render={
                      <Button
                        type="button"
                        variant="outline"
                        className="size-9 shrink-0"
                        aria-label="Choose icon"
                      />
                    }
                  >
                    <ScriptIcon icon={icon} className="size-4.5" />
                  </PopoverTrigger>
                  <PopoverPopup align="start">
                    <div className="grid grid-cols-3 gap-2">
                      {SCRIPT_ICONS.map((entry) => {
                        const isSelected = entry.id === icon;
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            className={`relative flex flex-col items-center gap-2 rounded-md border px-2 py-2 text-xs dark:border-transparent ${
                              isSelected
                                ? "border-primary/70 bg-primary/10 ring-inset dark:ring-1 dark:ring-primary/30"
                                : "border-border/70 hover:bg-accent/60 dark:bg-white/[0.035]"
                            }`}
                            onClick={() => {
                              setIcon(entry.id);
                              setIconPickerOpen(false);
                            }}
                          >
                            <ScriptIcon icon={entry.id} className="size-4" />
                            <span>{entry.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </PopoverPopup>
                </Popover>
                <Input
                  id="script-name"
                  autoFocus
                  placeholder="Test"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="script-keybinding">Keybinding</Label>
              <Input
                disabled={!canWriteSettings}
                id="script-keybinding"
                placeholder="Press shortcut"
                value={keybinding}
                readOnly
                onKeyDown={captureKeybinding}
              />
              <p className="text-xs text-muted-foreground">
                Press a shortcut. Use <code>Backspace</code> to clear. Shortcuts are
                environment-wide. Projects using the same action share its shortcut.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="script-type">Action type</Label>
              <Select
                value={actionType}
                onValueChange={(value) => {
                  if (value) setActionType(value);
                }}
              >
                <SelectTrigger id="script-type">
                  <SelectValue>{actionType === "prompt" ? "Prompt" : "Shell script"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="shell">Shell script</SelectItem>
                  <SelectItem value="prompt">Prompt</SelectItem>
                </SelectPopup>
              </Select>
            </div>
            {actionType === "prompt" ? (
              <div className="space-y-1.5">
                <Label htmlFor="script-prompt">Prompt</Label>
                <Textarea
                  id="script-prompt"
                  placeholder="Describe the task for the agent…"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={8}
                />
                <p className="text-xs text-muted-foreground">
                  Runs in the current thread with its selected model, workspace, and permissions. If
                  the agent is busy, the prompt is queued.
                </p>
                <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]">
                  <span>
                    <span className="block">Use the thread's current model</span>
                    <span className="block text-xs text-muted-foreground">
                      Turn off to switch the thread to a specific model and reasoning level first.
                    </span>
                  </span>
                  <Switch
                    checked={modelSelection === null}
                    disabled={modelSelection === null && fallbackModelSelection === null}
                    onCheckedChange={(checked) =>
                      setModelSelection(checked ? null : fallbackModelSelection)
                    }
                  />
                </label>
                {modelSelection !== null && (
                  <div className="flex flex-wrap items-center gap-2">
                    {effectiveModelSelection ? (
                      <>
                        <ProviderModelPicker
                          environmentId={environmentId}
                          activeInstanceId={effectiveModelSelection.instanceId}
                          model={effectiveModelSelection.model}
                          lockedProvider={null}
                          instanceEntries={instanceEntries}
                          modelOptionsByInstance={modelOptionsByInstance}
                          onInstanceModelChange={(instanceId, model) =>
                            setModelSelection(createModelSelection(instanceId, model))
                          }
                        />
                        {activeEntry && (
                          <TraitsPicker
                            provider={activeEntry.driverKind}
                            instanceId={effectiveModelSelection.instanceId}
                            models={activeEntry.models}
                            model={effectiveModelSelection.model}
                            promptUltrathink={readPromptUltrathink(prompt)}
                            onPromptEdit={(edit) => setPrompt((current) => edit(current))}
                            modelOptions={effectiveModelSelection.options}
                            planModeEnabled={settings.planModeEnabled}
                            onModelOptionsChange={(options) =>
                              setModelSelection(
                                createModelSelection(
                                  effectiveModelSelection.instanceId,
                                  effectiveModelSelection.model,
                                  options,
                                ),
                              )
                            }
                          />
                        )}
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        No agent models are available in this environment.
                      </p>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="script-command">Command</Label>
                  <Textarea
                    id="script-command"
                    placeholder="bun test"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="script-preview-url">Preview URL (optional)</Label>
                  <Input
                    id="script-preview-url"
                    placeholder="http://localhost:5173"
                    value={previewUrl}
                    onChange={(event) => setPreviewUrl(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Open this URL in the in-app preview when this action runs.
                  </p>
                </div>
                <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]">
                  <span>Run automatically on worktree creation</span>
                  <Switch
                    checked={runOnWorktreeCreate}
                    onCheckedChange={(checked) => setRunOnWorktreeCreate(Boolean(checked))}
                  />
                </label>
                <label
                  className={`flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035] ${
                    runOnWorktreeCreate ? "" : "opacity-60"
                  }`}
                >
                  <span>Wait for it to finish before the agent starts</span>
                  <Switch
                    checked={waitForSetup}
                    disabled={!runOnWorktreeCreate}
                    onCheckedChange={(checked) => setWaitForSetup(Boolean(checked))}
                  />
                </label>
                <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]">
                  <span>Run in the thread's worktree when the thread settles</span>
                  <Switch
                    checked={runOnSettle}
                    onCheckedChange={(checked) => setRunOnSettle(Boolean(checked))}
                  />
                </label>
                <label
                  className={`flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035] ${
                    previewUrl.trim().length === 0 ? "opacity-60" : ""
                  }`}
                >
                  <span>Open preview automatically when this action runs</span>
                  <Switch
                    checked={autoOpenPreview}
                    disabled={previewUrl.trim().length === 0}
                    onCheckedChange={(checked) => setAutoOpenPreview(Boolean(checked))}
                  />
                </label>
              </>
            )}
            {validationError && <p className="text-sm text-destructive">{validationError}</p>}
          </fieldset>
        </form>
      </DialogPanel>
      <DialogFooter variant="bare">
        {isEditing && (
          <Button
            type="button"
            variant="destructive-outline"
            className="mr-auto"
            disabled={isSaving || !canEditActions}
            onClick={() => onRequestDelete(name)}
          >
            Delete
          </Button>
        )}
        <Button type="button" variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button form={formId} type="submit" disabled={isSaving || !canEditActions}>
          {isSaving ? "Saving…" : isEditing ? "Save changes" : "Save action"}
        </Button>
      </DialogFooter>
    </>
  );
}
