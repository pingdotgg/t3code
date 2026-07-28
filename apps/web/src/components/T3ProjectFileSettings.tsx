import {
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type ProjectScriptIcon,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { FileJsonIcon, PlusIcon, RotateCcwIcon, SaveIcon, Trash2Icon } from "lucide-react";
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
  t3ProjectFileDraftKey,
  type T3ProjectFileDraft,
  type T3ProjectFileScriptDraft,
} from "~/t3ProjectFileSettings";

import { Button } from "./ui/button";
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
  const [draft, setDraft] = useState<T3ProjectFileDraft>(sourceDraft);
  const [savedDraftKey, setSavedDraftKey] = useState(() => t3ProjectFileDraftKey(sourceDraft));
  const [isSaving, setIsSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const nextScriptId = useRef(0);

  useEffect(() => {
    setDraft(sourceDraft);
    setSavedDraftKey(t3ProjectFileDraftKey(sourceDraft));
    setValidationError(null);
  }, [sourceDraft]);

  const draftKey = t3ProjectFileDraftKey(draft);
  const isDirty = draftKey !== savedDraftKey;
  const editingDisabled =
    isSaving ||
    state.status === "loading" ||
    state.status === "disabled" ||
    state.status === "invalid";

  const updateScript = useCallback(
    (index: number, update: (script: T3ProjectFileScriptDraft) => T3ProjectFileScriptDraft) => {
      setDraft((current) => ({
        ...current,
        scripts: current.scripts.map((script, scriptIndex) =>
          scriptIndex === index ? update(script) : script,
        ),
      }));
      setValidationError(null);
    },
    [],
  );

  const resetDraft = useCallback(() => {
    setDraft(sourceDraft);
    setValidationError(null);
  }, [sourceDraft]);

  const save = useCallback(async () => {
    if (editingDisabled) return;
    const built = buildT3ProjectFile(draft);
    if (!built.ok) {
      setValidationError(built.error);
      return;
    }

    setIsSaving(true);
    setValidationError(null);
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
          setValidationError(message);
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
      setDraft(nextDraft);
      setSavedDraftKey(t3ProjectFileDraftKey(nextDraft));
      toastManager.add({
        type: "success",
        title: `${T3_PROJECT_FILE_NAME} saved`,
        description: "Repository configuration was updated. The change is ready to commit.",
      });
    } finally {
      setIsSaving(false);
    }
  }, [cwd, draft, editingDisabled, environmentId, writeProjectFile]);

  const statusDescription =
    state.status === "ready"
      ? "Loaded from the repository root. Changes are shared through Git."
      : state.status === "invalid"
        ? (state.error ?? `${T3_PROJECT_FILE_NAME} is invalid.`)
        : state.status === "unavailable"
          ? `No readable ${T3_PROJECT_FILE_NAME} was found. Saving will create it.`
          : "Checking the repository configuration…";

  return (
    <>
      <SettingsRow
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
            title="Project icon path"
            description="Workspace-relative path used for the project icon."
            control={
              <Input
                id="t3-project-icon-path"
                className="w-full max-w-md"
                aria-label="Project icon path"
                value={draft.iconPath}
                disabled={editingDisabled}
                placeholder="assets/icon.svg"
                onChange={(event) => {
                  setDraft((current) => ({ ...current, iconPath: event.target.value }));
                  setValidationError(null);
                }}
              />
            }
          />

          <SettingsRow
            title="Shared actions"
            description={
              draft.scripts.length === 0
                ? `No shared actions are declared in ${T3_PROJECT_FILE_NAME}.`
                : `Commands declared in ${T3_PROJECT_FILE_NAME} for everyone using this repository.`
            }
            control={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={editingDisabled || draft.scripts.length >= 50}
                onClick={() => {
                  setDraft((current) => ({
                    ...current,
                    scripts: [
                      ...current.scripts,
                      createEmptyT3ProjectFileScriptDraft(`new-${nextScriptId.current++}`),
                    ],
                  }));
                  setValidationError(null);
                }}
              >
                <PlusIcon className="size-3.5" />
                Add action
              </Button>
            }
          >
            {draft.scripts.length > 0 ? (
              <div className="mt-3 border-t border-border/60">
                {draft.scripts.map((script, index) => (
                  <div
                    key={script.id}
                    className="space-y-3 border-b border-border/60 py-4 last:border-b-0"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-foreground">
                          {script.name.trim() || `Action ${index + 1}`}
                        </div>
                        {script.command.trim() ? (
                          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                            {script.command}
                          </div>
                        ) : null}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete shared action ${index + 1}`}
                        disabled={editingDisabled}
                        onClick={() => {
                          setDraft((current) => ({
                            ...current,
                            scripts: current.scripts.filter(
                              (_entry, scriptIndex) => scriptIndex !== index,
                            ),
                          }));
                          setValidationError(null);
                        }}
                      >
                        <Trash2Icon className="size-3.5 text-destructive" />
                      </Button>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                      <div className="space-y-1.5">
                        <Label htmlFor={`t3-script-name-${index}`}>Name</Label>
                        <Input
                          id={`t3-script-name-${index}`}
                          value={script.name}
                          disabled={editingDisabled}
                          placeholder="Setup Worktree"
                          onChange={(event) =>
                            updateScript(index, (current) => ({
                              ...current,
                              name: event.target.value,
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`t3-script-icon-${index}`}>Icon</Label>
                        <Select
                          value={script.icon}
                          disabled={editingDisabled}
                          onValueChange={(value) =>
                            updateScript(index, (current) => ({
                              ...current,
                              icon: value as ProjectScriptIcon,
                            }))
                          }
                        >
                          <SelectTrigger id={`t3-script-icon-${index}`} className="w-full">
                            <SelectValue>
                              {SCRIPT_ICON_OPTIONS.find((entry) => entry.value === script.icon)
                                ?.label ?? "Play"}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectPopup align="start">
                            {SCRIPT_ICON_OPTIONS.map((entry) => (
                              <SelectItem key={entry.value} value={entry.value}>
                                {entry.label}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor={`t3-script-command-${index}`}>Command</Label>
                      <Textarea
                        id={`t3-script-command-${index}`}
                        value={script.command}
                        disabled={editingDisabled}
                        placeholder="vp install"
                        onChange={(event) =>
                          updateScript(index, (current) => ({
                            ...current,
                            command: event.target.value,
                          }))
                        }
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor={`t3-script-preview-url-${index}`}>
                        Preview URL (optional)
                      </Label>
                      <Input
                        id={`t3-script-preview-url-${index}`}
                        value={script.previewUrl}
                        disabled={editingDisabled}
                        placeholder="http://localhost:5173"
                        onChange={(event) =>
                          updateScript(index, (current) => ({
                            ...current,
                            previewUrl: event.target.value,
                            autoOpenPreview:
                              event.target.value.trim().length > 0
                                ? current.autoOpenPreview
                                : false,
                          }))
                        }
                      />
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="flex items-center justify-between gap-3 py-2 text-sm">
                        <span>Run when a worktree is created</span>
                        <Switch
                          checked={script.runOnWorktreeCreate}
                          disabled={editingDisabled}
                          onCheckedChange={(checked) =>
                            updateScript(index, (current) => ({
                              ...current,
                              runOnWorktreeCreate: Boolean(checked),
                            }))
                          }
                        />
                      </label>
                      <label
                        className={`flex items-center justify-between gap-3 py-2 text-sm ${
                          script.previewUrl.trim().length === 0 ? "opacity-60" : ""
                        }`}
                      >
                        <span>Open preview automatically</span>
                        <Switch
                          checked={script.autoOpenPreview}
                          disabled={editingDisabled || script.previewUrl.trim().length === 0}
                          onCheckedChange={(checked) =>
                            updateScript(index, (current) => ({
                              ...current,
                              autoOpenPreview: Boolean(checked),
                            }))
                          }
                        />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </SettingsRow>
        </>
      )}
    </>
  );
}
