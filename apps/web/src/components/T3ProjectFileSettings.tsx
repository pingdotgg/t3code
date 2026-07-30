import {
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectScriptIcon,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  FileJsonIcon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  SettingsIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { T3ProjectFileState } from "~/hooks/useT3ProjectFileScripts";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  confirmProjectFileQueryData,
  setProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import {
  buildT3ProjectFile,
  createEmptyT3ProjectFileScriptDraft,
  createT3ProjectFileDraft,
  createT3ProjectFileDraftState,
  reconcileT3ProjectFileDraftState,
  t3ProjectFileDraftKey,
  updateT3ProjectFileScriptPreviewUrl,
  type T3ProjectFileDraft,
  type T3ProjectFileScriptDraft,
} from "~/t3ProjectFileSettings";

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
import { ScriptIcon } from "./ProjectScriptsControl";
import { SettingsRow } from "./settings/settingsLayout";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Spinner } from "./ui/spinner";
import { Switch } from "./ui/switch";
import { Textarea } from "./ui/textarea";
import { stackedThreadToast, toastManager } from "./ui/toast";

const SCRIPT_ICON_OPTIONS: ReadonlyArray<{
  readonly value: ProjectScriptIcon;
  readonly label: string;
}> = [
  { value: "play", label: "Play" },
  { value: "test", label: "Test" },
  { value: "lint", label: "Lint" },
  { value: "configure", label: "Configure" },
  { value: "build", label: "Build" },
  { value: "debug", label: "Debug" },
];

interface T3ProjectFileSettingsProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly state: T3ProjectFileState;
}

export default function T3ProjectFileSettings({
  environmentId,
  cwd,
  state,
}: T3ProjectFileSettingsProps) {
  const writeProjectFile = useAtomCommand(projectEnvironment.writeFile, {
    reportFailure: false,
  });
  const sourceDraft = useMemo(() => createT3ProjectFileDraft(state.file), [state.file]);
  const [draftState, setDraftState] = useState(() => createT3ProjectFileDraftState(sourceDraft));
  const [isSaving, setIsSaving] = useState(false);
  const nextScriptId = useRef(0);

  useEffect(() => {
    setDraftState((current) => reconcileT3ProjectFileDraftState(current, sourceDraft));
  }, [sourceDraft]);

  const { draft, source, validationError } = draftState;
  const draftKey = t3ProjectFileDraftKey(draft);
  const isDirty = draftKey !== t3ProjectFileDraftKey(source);
  const editingDisabled =
    isSaving ||
    state.status === "loading" ||
    state.status === "disabled" ||
    state.status === "invalid";

  const updateDraft = useCallback((update: (draft: T3ProjectFileDraft) => T3ProjectFileDraft) => {
    setDraftState((current) => ({
      ...current,
      draft: update(current.draft),
      validationError: null,
    }));
  }, []);

  const resetDraft = useCallback(() => {
    setDraftState((current) => ({
      ...current,
      draft: current.source,
      validationError: null,
    }));
  }, []);

  const save = useCallback(
    async (overrideDraft?: T3ProjectFileDraft) => {
      if (editingDisabled) return;
      const built = buildT3ProjectFile(overrideDraft ?? draft);
      if (!built.ok) {
        setDraftState((current) => ({ ...current, validationError: built.error }));
        return;
      }

      setIsSaving(true);
      setDraftState((current) => ({ ...current, validationError: null }));
      try {
        const result = await writeProjectFile({
          environmentId,
          input: {
            cwd,
            relativePath: T3_PROJECT_FILE_NAME,
            contents: built.contents,
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            const message =
              error instanceof Error ? error.message : `Failed to save ${T3_PROJECT_FILE_NAME}.`;
            setDraftState((current) => ({ ...current, validationError: message }));
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: `Unable to save ${T3_PROJECT_FILE_NAME}`,
                description: message,
              }),
            );
          }
          return;
        }

        setProjectFileQueryData(environmentId, cwd, T3_PROJECT_FILE_NAME, built.contents);
        confirmProjectFileQueryData(environmentId, cwd, T3_PROJECT_FILE_NAME, built.contents);
        const nextDraft = createT3ProjectFileDraft(built.file);
        setDraftState(createT3ProjectFileDraftState(nextDraft));
        toastManager.add({
          type: "success",
          title: `${T3_PROJECT_FILE_NAME} saved`,
          description: "Repository configuration was updated. The change is ready to commit.",
        });
      } finally {
        setIsSaving(false);
      }
    },
    [cwd, draft, editingDisabled, environmentId, writeProjectFile],
  );

  // Shared actions are edited in a dialog and written straight to t3.json, so
  // the list stays a scannable row per action instead of a stack of forms.
  const [editorState, setEditorState] = useState<{
    readonly index: number | null;
    readonly script: T3ProjectFileScriptDraft;
  } | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);

  const openAddAction = useCallback(() => {
    setEditorError(null);
    setEditorState({
      index: null,
      script: createEmptyT3ProjectFileScriptDraft(`new-${nextScriptId.current++}`),
    });
  }, []);

  const openEditAction = useCallback((index: number, script: T3ProjectFileScriptDraft) => {
    setEditorError(null);
    setEditorState({ index, script });
  }, []);

  const closeEditor = useCallback(() => {
    setEditorState(null);
    setEditorError(null);
  }, []);

  const updateEditorScript = useCallback(
    (update: (script: T3ProjectFileScriptDraft) => T3ProjectFileScriptDraft) => {
      setEditorState((current) =>
        current ? { ...current, script: update(current.script) } : null,
      );
    },
    [],
  );

  const commitEditorAction = useCallback(() => {
    if (!editorState) return;
    const entry = editorState.script;
    if (!entry.name.trim()) {
      setEditorError("Name is required.");
      return;
    }
    if (!entry.command.trim()) {
      setEditorError("Command is required.");
      return;
    }
    const scripts =
      editorState.index === null
        ? [...draft.scripts, entry]
        : draft.scripts.map((script, index) => (index === editorState.index ? entry : script));
    const nextDraft = { ...draft, scripts };
    setDraftState((current) => ({ ...current, draft: nextDraft, validationError: null }));
    setEditorState(null);
    setEditorError(null);
    void save(nextDraft);
  }, [draft, editorState, save]);

  const deleteAction = useCallback(
    (index: number) => {
      const nextDraft = {
        ...draft,
        scripts: draft.scripts.filter((_entry, scriptIndex) => scriptIndex !== index),
      };
      setDraftState((current) => ({ ...current, draft: nextDraft, validationError: null }));
      void save(nextDraft);
    },
    [draft, save],
  );

  const sharedActionEditor = (
    <Dialog
      open={editorState !== null}
      onOpenChange={(open) => {
        if (!open) closeEditor();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {editorState?.index === null ? "Add Shared Action" : "Edit Shared Action"}
          </DialogTitle>
          <DialogDescription>
            Shared actions live in {T3_PROJECT_FILE_NAME} and reach everyone using this repository.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <div className="space-y-1.5">
              <Label htmlFor="t3-shared-action-name">Name</Label>
              <Input
                id="t3-shared-action-name"
                value={editorState?.script.name ?? ""}
                placeholder="Setup worktree"
                onChange={(event) =>
                  updateEditorScript((current) => ({ ...current, name: event.target.value }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t3-shared-action-icon">Icon</Label>
              <Select
                value={editorState?.script.icon ?? "play"}
                onValueChange={(value) =>
                  updateEditorScript((current) => ({
                    ...current,
                    icon: value as ProjectScriptIcon,
                  }))
                }
              >
                <SelectTrigger id="t3-shared-action-icon" className="w-full">
                  <SelectValue>
                    <span className="flex min-w-0 items-center gap-2">
                      <ScriptIcon icon={editorState?.script.icon ?? "play"} />
                      <span className="truncate">
                        {SCRIPT_ICON_OPTIONS.find(
                          (entry) => entry.value === editorState?.script.icon,
                        )?.label ?? "Play"}
                      </span>
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="start">
                  {SCRIPT_ICON_OPTIONS.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      <span className="flex items-center gap-2">
                        <ScriptIcon icon={entry.value} />
                        {entry.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="t3-shared-action-command">Command</Label>
            <Textarea
              id="t3-shared-action-command"
              value={editorState?.script.command ?? ""}
              placeholder="vp install"
              onChange={(event) =>
                updateEditorScript((current) => ({ ...current, command: event.target.value }))
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="t3-shared-action-preview-url">Preview URL (optional)</Label>
            <Input
              id="t3-shared-action-preview-url"
              value={editorState?.script.previewUrl ?? ""}
              placeholder="http://localhost:5173"
              onChange={(event) =>
                updateEditorScript((current) =>
                  updateT3ProjectFileScriptPreviewUrl(current, event.target.value),
                )
              }
            />
          </div>

          <div className="grid gap-1">
            <label className="flex items-center justify-between gap-3 py-1.5 text-sm">
              <span>Run when a worktree is created</span>
              <Switch
                checked={editorState?.script.runOnWorktreeCreate ?? false}
                onCheckedChange={(checked) =>
                  updateEditorScript((current) => ({
                    ...current,
                    runOnWorktreeCreate: Boolean(checked),
                  }))
                }
              />
            </label>
            <label
              className={`flex items-center justify-between gap-3 py-1.5 text-sm ${
                (editorState?.script.previewUrl ?? "").trim().length === 0 ? "opacity-60" : ""
              }`}
            >
              <span>Open preview automatically</span>
              <Switch
                checked={editorState?.script.autoOpenPreview ?? false}
                disabled={(editorState?.script.previewUrl ?? "").trim().length === 0}
                onCheckedChange={(checked) =>
                  updateEditorScript((current) => ({
                    ...current,
                    autoOpenPreview: Boolean(checked),
                  }))
                }
              />
            </label>
          </div>

          {editorError ? <p className="text-xs text-destructive">{editorError}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={closeEditor}>
            Cancel
          </Button>
          <Button type="button" disabled={editingDisabled} onClick={commitEditorAction}>
            {editorState?.index === null ? "Add action" : "Save action"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );

  const statusDescription =
    state.status === "ready"
      ? null
      : state.status === "invalid"
        ? (state.error ?? `${T3_PROJECT_FILE_NAME} is invalid.`)
        : state.status === "unavailable"
          ? `No readable ${T3_PROJECT_FILE_NAME} was found. Saving will create it.`
          : "Checking the repository configuration…";

  return (
    <>
      <SettingsRow
        className="min-h-14 py-3"
        title={
          <span className="flex items-center gap-2">
            <FileJsonIcon className="size-4 text-muted-foreground" />
            {T3_PROJECT_FILE_NAME}
            {state.status === "loading" ? <Spinner className="size-3.5" /> : null}
          </span>
        }
        description={statusDescription}
        status={
          validationError ? <span className="text-destructive">{validationError}</span> : undefined
        }
        control={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!isDirty || isSaving}
              onClick={resetDraft}
            >
              <RotateCcwIcon className="size-3.5" />
              Reset
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!isDirty || editingDisabled}
              onClick={() => void save()}
            >
              {isSaving ? <Spinner className="size-3.5" /> : <SaveIcon className="size-3.5" />}
              {state.status === "unavailable" ? `Create ${T3_PROJECT_FILE_NAME}` : "Save"}
            </Button>
          </div>
        }
      />

      {state.status === "invalid" ? (
        <SettingsRow
          title="Editor unavailable"
          description="This file cannot be edited safely as a form until its JSON matches the current schema."
        />
      ) : (
        <>
          <SettingsRow
            className="min-h-14 py-3"
            title="Project icon path"
            description="Workspace-relative icon path."
            control={
              <Input
                id="t3-project-icon-path"
                className="w-full max-w-md"
                aria-label="Project icon path"
                value={draft.iconPath}
                disabled={editingDisabled}
                placeholder="assets/icon.svg"
                onChange={(event) => {
                  updateDraft((current) => ({ ...current, iconPath: event.target.value }));
                }}
              />
            }
          />

          <div className="flex min-h-14 min-w-0 items-center gap-3 rounded-lg px-3 py-3 sm:px-4">
            <div className="shrink-0 text-sm font-medium text-foreground">Shared actions</div>
            {draft.scripts.length === 0 ? (
              <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                None declared in {T3_PROJECT_FILE_NAME}.
              </div>
            ) : (
              <div className="min-w-0 flex-1" />
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={editingDisabled || draft.scripts.length >= 50}
              onClick={openAddAction}
            >
              <PlusIcon className="size-3.5" />
              Add action
            </Button>
          </div>

          {draft.scripts.map((script, index) => {
            const label = script.name.trim() || `Action ${index + 1}`;
            return (
              <div key={script.id}>
                <div className="flex min-h-14 min-w-0 items-center gap-3 rounded-lg px-3 py-3 sm:px-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{label}</span>
                      {script.runOnWorktreeCreate ? (
                        <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          Setup
                        </span>
                      ) : null}
                      {script.previewUrl.trim() ? (
                        <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          Preview
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={editingDisabled}
                      aria-label={`Edit shared action ${label}`}
                      onClick={() => openEditAction(index, script)}
                    >
                      <SettingsIcon className="size-3.5" />
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="destructive-outline"
                      size="sm"
                      disabled={editingDisabled}
                      aria-label={`Delete shared action ${label}`}
                      onClick={() => deleteAction(index)}
                    >
                      <Trash2Icon className="size-3.5" />
                      Delete
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}

          {sharedActionEditor}
        </>
      )}
    </>
  );
}
