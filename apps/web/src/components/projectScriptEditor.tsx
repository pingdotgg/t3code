import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ProjectScript,
  type ProjectScriptIcon,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  BugIcon,
  FlaskConicalIcon,
  HammerIcon,
  ListChecksIcon,
  PlayIcon,
  Trash2Icon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import React, { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";

import {
  keybindingValueForCommand,
  decodeProjectScriptKeybindingRule,
} from "~/lib/projectScriptKeybindings";
import { keybindingFromKeyboardEvent } from "~/components/settings/KeybindingsSettings.logic";
import { commandForProjectScript, nextProjectScriptId } from "~/projectScripts";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
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
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Checkbox } from "./ui/checkbox";
import { Kbd } from "./ui/kbd";
import { formatShortcutKeyLabel } from "~/keybindings";
import { isMacPlatform } from "~/lib/utils";
import { DialogSubmitKbd, isDialogSubmitShortcut } from "./DialogSubmitShortcut";
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

/** Key cap labels for a stored keybinding such as `mod+shift+r`. */
function keybindingKeyCaps(value: string): ReadonlyArray<string> {
  const mac = isMacPlatform(navigator.platform);
  return value
    .split("+")
    .filter((part) => part.length > 0)
    .map((part) => {
      if (part === "mod") return mac ? "\u2318" : "Ctrl";
      if (part === "meta") return mac ? "\u2318" : "Meta";
      if (part === "ctrl") return mac ? "\u2303" : "Ctrl";
      if (part === "alt") return mac ? "\u2325" : "Alt";
      if (part === "shift") return mac ? "\u21e7" : "Shift";
      return formatShortcutKeyLabel(part);
    });
}

/**
 * Records a shortcut on keydown and shows it as key caps. Backspace or Delete, or the clear
 * button, removes it.
 */
function KeybindingField(props: {
  readonly id: string;
  readonly value: string;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly onClear: () => void;
  readonly disabled?: boolean;
}) {
  const caps = props.value ? keybindingKeyCaps(props.value) : [];
  return (
    <div className="relative flex h-8.5 min-w-0 items-center gap-1 rounded-control surface-well kbd-in-control ps-2 pe-1 text-base has-focus-visible:surface-focus sm:h-7.5 sm:text-sm">
      <input
        id={props.id}
        readOnly
        disabled={props.disabled}
        value={props.value}
        onKeyDown={props.onKeyDown}
        aria-description="Press a shortcut. Backspace clears it. Shortcuts are environment-wide."
        className="absolute inset-0 size-full cursor-pointer rounded-[inherit] opacity-0 outline-none"
      />
      {caps.length > 0 ? (
        caps.map((cap, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- caps can repeat
          <Kbd key={`${cap}-${index}`}>{cap}</Kbd>
        ))
      ) : (
        <span className="pointer-events-none truncate text-placeholder">Press shortcut</span>
      )}
      {caps.length > 0 ? (
        <Button
          type="button"
          variant="ghost-muted"
          size="icon-xs"
          aria-label="Clear keybinding"
          disabled={props.disabled}
          onClick={props.onClear}
          className="relative ms-auto shrink-0"
        >
          <XIcon aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}

export interface NewProjectScriptInput {
  name: string;
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
      command: script.command,
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
  request,
  scripts,
  onSubmit,
  onDelete,
  onClose,
}: {
  environmentId: EnvironmentId;
  editScope?: typeof AuthOrchestrationOperateScope | typeof AuthSettingsWriteScope;
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
  // Scope errors by request so late saves cannot overwrite a newer request's error.
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
  // The last opened request stays shown while the dialog animates closed. Each
  // new request mounts a fresh form, which drops the previous request's save.
  const [shown, setShown] = useState<{
    readonly request: ProjectScriptEditorRequest;
    readonly key: number;
  } | null>(request === null ? null : { request, key: 0 });
  if (request !== null && request !== shown?.request) {
    setShown({ request, key: (shown?.key ?? 0) + 1 });
  }
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
        <DialogPopup className="sm:max-w-115">
          {shown ? (
            <ProjectScriptEditorForm
              key={shown.key}
              environmentId={environmentId}
              editScope={editScope}
              request={shown.request}
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
          ) : null}
        </DialogPopup>
      </Dialog>

      <AlertDialog open={deleteConfirmOpen && canEditActions} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup className="sm:max-w-105">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete action "{deleteName}"?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button size="standard" variant="secondary" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="standard"
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
  request: ProjectScriptEditorRequest;
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
  const formRef = useRef<HTMLFormElement | null>(null);
  const [name, setName] = useState(request.initial.name);
  const [command, setCommand] = useState(request.initial.command);
  const [icon, setIcon] = useState<ProjectScriptIcon>(request.initial.icon);
  const [iconPickerOpen, setIconPickerOpen] = useComposerMenuState(!canEditActions);
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(
    request.initial.runOnWorktreeCreate,
  );
  const [waitForSetup, setWaitForSetup] = useState(request.initial.waitForSetup);
  const [runOnSettle, setRunOnSettle] = useState(request.initial.runOnSettle);
  const [keybinding, setKeybinding] = useState(request.initial.keybinding ?? "");
  const [previewUrl, setPreviewUrl] = useState(request.initial.previewUrl ?? "");
  const [autoOpenPreview, setAutoOpenPreview] = useState(request.initial.autoOpenPreview);
  const [isSaving, setIsSaving] = useState(false);
  const pendingSubmissionRef = useRef<object | null>(null);
  // A save that settles after this form is replaced must not close or error
  // the request that replaced it.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops the pending save on unmount so a late result cannot close or fail the next request
  useEffect(
    () => () => {
      pendingSubmissionRef.current = null;
    },
    [],
  );

  const isEditing = request.scriptId != null;

  const close = () => {
    pendingSubmissionRef.current = null;
    setIsSaving(false);
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
    if (pendingSubmissionRef.current !== null) return;
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
    if (trimmedCommand.length === 0) {
      setValidationError("Command is required.");
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

    const submission = {};
    pendingSubmissionRef.current = submission;
    setIsSaving(true);
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
      setIsSaving(false);
    }
  };

  const handleSubmitShortcut = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || !isDialogSubmitShortcut(event) || isSaving) return;
    event.preventDefault();
    formRef.current?.requestSubmit();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isEditing ? "Edit action" : "Add action"}</DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <form id={formId} ref={formRef} onSubmit={submit} onKeyDown={handleSubmitShortcut}>
          <fieldset className="space-y-4" disabled={isSaving || !canEditActions}>
            <div className="grid grid-cols-[minmax(0,1fr)_12rem] gap-3">
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="script-name">Name</Label>
                <div className="flex items-center gap-2">
                  <Popover onOpenChange={setIconPickerOpen} open={iconPickerOpen}>
                    <PopoverTrigger
                      render={
                        <Button
                          type="button"
                          variant="secondary"
                          size="icon"
                          className="shrink-0"
                          aria-label="Choose icon"
                        />
                      }
                    >
                      <ScriptIcon icon={icon} className="size-4" />
                    </PopoverTrigger>
                    <PopoverPopup align="start">
                      <div className="grid grid-cols-3 gap-2">
                        {SCRIPT_ICONS.map((entry) => {
                          const isSelected = entry.id === icon;
                          return (
                            <button
                              key={entry.id}
                              type="button"
                              className={`relative flex flex-col items-center gap-2 rounded-item border px-2 py-2 text-xs ${
                                isSelected
                                  ? "border-border surface-selected-soft text-strong-foreground"
                                  : "border-border/70 surface-card-settings hover:surface-ghost-hover"
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
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="script-keybinding">Keybinding</Label>
                <KeybindingField
                  id="script-keybinding"
                  value={keybinding}
                  onKeyDown={captureKeybinding}
                  onClear={() => setKeybinding("")}
                  disabled={!canWriteSettings}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="script-command">Command</Label>
              <Textarea
                id="script-command"
                placeholder="bun test"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="script-preview-url">Preview URL (optional)</Label>
              <Input
                id="script-preview-url"
                font="mono"
                placeholder="http://localhost:5173"
                value={previewUrl}
                onChange={(event) => setPreviewUrl(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2.5">
              <label className="flex items-center gap-2.5 text-body text-foreground">
                <Checkbox
                  checked={runOnWorktreeCreate}
                  onCheckedChange={(checked) => setRunOnWorktreeCreate(Boolean(checked))}
                />
                Run automatically on worktree creation
              </label>
              <label
                className={`flex items-center gap-2.5 text-body text-foreground ${
                  runOnWorktreeCreate ? "" : "opacity-60"
                }`}
              >
                <Checkbox
                  checked={waitForSetup}
                  disabled={!runOnWorktreeCreate}
                  onCheckedChange={(checked) => setWaitForSetup(Boolean(checked))}
                />
                Wait for it to finish before the agent starts
              </label>
              <label
                className={`flex items-center gap-2.5 text-body text-foreground ${
                  previewUrl.trim().length === 0 ? "opacity-60" : ""
                }`}
              >
                <Checkbox
                  checked={autoOpenPreview}
                  disabled={previewUrl.trim().length === 0}
                  onCheckedChange={(checked) => setAutoOpenPreview(Boolean(checked))}
                />
                Open preview automatically when this action runs
              </label>
              <label className="flex items-center gap-2.5 text-body text-foreground">
                <Checkbox
                  checked={runOnSettle}
                  onCheckedChange={(checked) => setRunOnSettle(Boolean(checked))}
                />
                Run in the thread's worktree when the thread settles
              </label>
            </div>
            {validationError && <p className="text-body text-destructive">{validationError}</p>}
          </fieldset>
        </form>
      </DialogPanel>
      <DialogFooter variant="bare" onKeyDown={handleSubmitShortcut}>
        {isEditing && (
          <Button
            type="button"
            size="standard"
            variant="secondary"
            className="sm:mr-auto"
            disabled={isSaving || !canEditActions}
            onClick={() => onRequestDelete(name)}
          >
            <Trash2Icon aria-hidden />
            Delete
          </Button>
        )}
        <Button type="button" size="standard" variant="secondary" onClick={close}>
          Cancel
        </Button>
        <Button form={formId} type="submit" size="standard" disabled={isSaving || !canEditActions}>
          {isSaving ? "Saving…" : isEditing ? "Save changes" : "Save action"}
          {isSaving ? null : <DialogSubmitKbd />}
        </Button>
      </DialogFooter>
    </>
  );
}
