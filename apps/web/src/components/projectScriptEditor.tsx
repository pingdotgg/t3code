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
  WrenchIcon,
} from "lucide-react";
import React, { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { translateDynamic } from "../i18nCore";

const td = (key: string, options?: Record<string, unknown>) =>
  translateDynamic(`scripts:${key}`, options);

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
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";

const SCRIPT_ICONS: ProjectScriptIcon[] = ["play", "test", "lint", "configure", "build", "debug"];

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
  command: string;
  icon: ProjectScriptIcon;
  runOnWorktreeCreate: boolean;
  waitForSetup: boolean;
  runOnSettle: boolean;
  stopOnSettle?: boolean;
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
  stopOnSettle: false,
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
      stopOnSettle: script.stopOnSettle ?? false,
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
  const { t } = useTranslation("scripts");

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
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle", { name: deleteName })}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{t("cancel")}</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={!canEditActions}
              onClick={() => {
                if (!request?.scriptId) return;
                if (!readEnvironmentScope(environmentId, editScope)) {
                  setValidationError(t("cannotChangeActions"));
                  return;
                }
                setDeleteConfirmOpen(false);
                onClose();
                onDelete(request.scriptId);
              }}
            >
              {t("deleteAction")}
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
  const { t } = useTranslation("scripts");
  const formId = React.useId();
  const [name, setName] = useState(request.initial.name);
  const [command, setCommand] = useState(request.initial.command);
  const [icon, setIcon] = useState<ProjectScriptIcon>(request.initial.icon);
  const [iconPickerOpen, setIconPickerOpen] = useComposerMenuState(!canEditActions);
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(
    request.initial.runOnWorktreeCreate,
  );
  const [waitForSetup, setWaitForSetup] = useState(request.initial.waitForSetup);
  const [runOnSettle, setRunOnSettle] = useState(request.initial.runOnSettle);
  const [stopOnSettle, setStopOnSettle] = useState(request.initial.stopOnSettle ?? false);
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
      setValidationError(t("cannotChangeActions"));
      return;
    }
    const changesKeybinding =
      (keybinding.trim() || null) !== (request.initial.keybinding?.trim() || null);
    const canChangeKeybinding = readEnvironmentScope(environmentId, AuthSettingsWriteScope);
    if (changesKeybinding && !canChangeKeybinding) {
      setValidationError(t("cannotChangeShortcuts"));
      return;
    }
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (trimmedName.length === 0) {
      setValidationError(t("nameRequired"));
      return;
    }
    if (trimmedCommand.length === 0) {
      setValidationError(t("commandRequired"));
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
        stopOnSettle,
        ...((request.scriptId === null && canChangeKeybinding) || changesKeybinding
          ? { keybinding: keybindingRule?.key ?? null }
          : {}),
        previewUrl: trimmedPreviewUrl.length > 0 ? trimmedPreviewUrl : null,
        autoOpenPreview: trimmedPreviewUrl.length > 0 ? autoOpenPreview : false,
      } satisfies NewProjectScriptInput;
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : t("saveFailed"));
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
            setValidationError(error instanceof Error ? error.message : t("saveFailed"));
          }
        } else {
          close();
        }
      }
    } catch (error) {
      if (pendingSubmissionRef.current === submission) {
        setValidationError(error instanceof Error ? error.message : t("saveFailed"));
      }
    }
    if (pendingSubmissionRef.current === submission) {
      pendingSubmissionRef.current = null;
      setIsSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isEditing ? t("editor.editAction") : t("editor.addAction")}</DialogTitle>
        <DialogDescription>{t("editor.description")}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form id={formId} onSubmit={submit}>
          <fieldset className="space-y-4" disabled={isSaving || !canEditActions}>
            <div className="space-y-1.5">
              <Label htmlFor="script-name">{t("editor.name")}</Label>
              <div className="flex items-center gap-2">
                <Popover onOpenChange={setIconPickerOpen} open={iconPickerOpen}>
                  <PopoverTrigger
                    render={
                      <Button
                        type="button"
                        variant="outline"
                        className="size-9 shrink-0"
                        aria-label={t("aria.chooseIcon")}
                      />
                    }
                  >
                    <ScriptIcon icon={icon} className="size-4.5" />
                  </PopoverTrigger>
                  <PopoverPopup align="start">
                    <div className="grid grid-cols-3 gap-2">
                      {SCRIPT_ICONS.map((entry) => {
                        const isSelected = entry === icon;
                        return (
                          <button
                            key={entry}
                            type="button"
                            className={`relative flex flex-col items-center gap-2 rounded-md border px-2 py-2 text-xs dark:border-transparent ${
                              isSelected
                                ? "border-primary/70 bg-primary/10 ring-inset dark:ring-1 dark:ring-primary/30"
                                : "border-border/70 hover:bg-accent/60 dark:bg-white/[0.035]"
                            }`}
                            onClick={() => {
                              setIcon(entry);
                              setIconPickerOpen(false);
                            }}
                          >
                            <ScriptIcon icon={entry} className="size-4" />
                            <span>{td(`icons.${entry}`)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </PopoverPopup>
                </Popover>
                <Input
                  id="script-name"
                  autoFocus
                  placeholder={t("editor.namePlaceholder")}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="script-keybinding">{t("editor.keybinding")}</Label>
              <Input
                disabled={!canWriteSettings}
                id="script-keybinding"
                placeholder={t("editor.keybindingPlaceholder")}
                value={keybinding}
                readOnly
                onKeyDown={captureKeybinding}
              />
              <p className="text-xs text-muted-foreground">
                <Trans i18nKey={"editor.keybindingHint" as never} components={[<code key="0" />]} />
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="script-command">{t("editor.command")}</Label>
              <Textarea
                id="script-command"
                placeholder={t("editor.commandPlaceholder")}
                value={command}
                onChange={(event) => setCommand(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="script-preview-url">{t("editor.previewUrl")}</Label>
              <Input
                id="script-preview-url"
                placeholder="http://localhost:5173"
                value={previewUrl}
                onChange={(event) => setPreviewUrl(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("editor.previewUrlHint")}</p>
            </div>
            <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]">
              <span>{t("editor.runOnWorktreeCreate")}</span>
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
              <span>{t("editor.waitForSetup")}</span>
              <Switch
                checked={waitForSetup}
                disabled={!runOnWorktreeCreate}
                onCheckedChange={(checked) => setWaitForSetup(Boolean(checked))}
              />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]">
              <span>{t("editor.runOnSettle")}</span>
              <Switch
                checked={runOnSettle}
                onCheckedChange={(checked) => setRunOnSettle(Boolean(checked))}
              />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]">
              <span>{t("editor.stopOnSettle")}</span>
              <Switch
                checked={stopOnSettle}
                onCheckedChange={(checked) => setStopOnSettle(Boolean(checked))}
              />
            </label>
            <label
              className={`flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035] ${
                previewUrl.trim().length === 0 ? "opacity-60" : ""
              }`}
            >
              <span>{t("editor.autoOpenPreview")}</span>
              <Switch
                checked={autoOpenPreview}
                disabled={previewUrl.trim().length === 0}
                onCheckedChange={(checked) => setAutoOpenPreview(Boolean(checked))}
              />
            </label>
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
            {t("editor.delete")}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={close}>
          {t("cancel")}
        </Button>
        <Button form={formId} type="submit" disabled={isSaving || !canEditActions}>
          {isSaving
            ? t("editor.saving")
            : isEditing
              ? t("editor.saveChanges")
              : t("editor.saveAction")}
        </Button>
      </DialogFooter>
    </>
  );
}
