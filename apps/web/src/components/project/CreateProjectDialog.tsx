import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { filterFilesystemBrowseEntries } from "@t3tools/client-runtime/state/filesystem";
import type { EnvironmentId } from "@t3tools/contracts";
import { FolderIcon, FolderPlusIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Radio, RadioGroup } from "~/components/ui/radio-group";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { toastManager } from "~/components/ui/toast";
import { onOpenCreateProjectDialog } from "~/createProjectDialogBus";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { readLocalApi } from "~/localApi";
import { cn, newProjectId } from "~/lib/utils";
import { useEnvironments } from "~/state/environments";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { filesystemEnvironment } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  createProjectDraftInitialState,
  reduceCreateProjectDraft,
  validateCreateProjectDraft,
  type CreateProjectDraftState,
} from "./CreateProjectDialog.logic";

let nextFolderKey = 0;
/** Stable React key for a draft row. Local to this dialog, never persisted. */
function makeFolderId(): string {
  nextFolderKey += 1;
  return `folder-${nextFolderKey}`;
}

function browsePlatformOf(os: string | null | undefined): string {
  if (os === "win32") return "Windows";
  if (os === "darwin") return "macOS";
  return "Linux";
}

/**
 * A single source-folder row: primary radio, path field with directory
 * suggestions, and a remove button.
 */
function SourceFolderRow(props: {
  readonly folderId: string;
  readonly environmentId: EnvironmentId | null;
  readonly value: string;
  readonly isPrimary: boolean;
  readonly showPrimarySelector: boolean;
  readonly canRemove: boolean;
  readonly error: string | null;
  readonly onChange: (next: string) => void;
  readonly onRemove: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const trimmed = props.value.trim();
  // Only suggest once the user has typed a directory-ish prefix; an empty field
  // would otherwise fire a browse for every row on open.
  const browse = useEnvironmentQuery(
    focused && props.environmentId !== null && trimmed.length > 0
      ? filesystemEnvironment.browse({
          environmentId: props.environmentId,
          input: { partialPath: trimmed },
        })
      : null,
  );
  const suggestions = useMemo(() => {
    const entries = browse.data?.entries ?? [];
    const lastSeparator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    const filter = lastSeparator === -1 ? trimmed : trimmed.slice(lastSeparator + 1);
    return (
      filterFilesystemBrowseEntries(entries, filter)
        .visibleEntries
        // A suggestion identical to what is already typed is noise, and while it
        // renders it covers the "Add folder" button directly beneath the row.
        .filter((entry) => entry.fullPath !== trimmed)
        .slice(0, 6)
    );
  }, [browse.data?.entries, trimmed]);

  return (
    <div className="grid gap-1">
      <div className="flex min-w-0 items-center gap-2">
        {props.showPrimarySelector ? (
          <Radio value={props.folderId} aria-label="Make this the primary folder" />
        ) : null}
        <div className="relative min-w-0 flex-1">
          <FolderIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 opacity-60" />
          <Input
            aria-label="Source folder path"
            className={cn("pl-8 font-mono text-xs", props.error ? "border-destructive/64" : null)}
            value={props.value}
            placeholder="~/code/my-app"
            onChange={(event) => props.onChange(event.currentTarget.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          />
          {focused && suggestions.length > 0 ? (
            <div className="absolute top-full right-0 left-0 z-50 mt-1 overflow-hidden rounded-md border border-border bg-popover shadow-md">
              {suggestions.map((entry) => (
                <button
                  key={entry.fullPath}
                  type="button"
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs hover:bg-accent"
                  // Fires before the input's blur so the row keeps browsing.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    props.onChange(entry.fullPath);
                  }}
                >
                  <FolderIcon className="size-3.5 shrink-0 opacity-60" />
                  <span className="truncate">{entry.name}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        {props.isPrimary && props.showPrimarySelector ? (
          <Badge variant="secondary" className="shrink-0">
            Primary
          </Badge>
        ) : null}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Remove folder"
          disabled={!props.canRemove}
          onClick={props.onRemove}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      {props.error ? <p className="pl-1 text-destructive text-xs">{props.error}</p> : null}
    </div>
  );
}

function CreateProjectDialogContent(props: {
  readonly initial: CreateProjectDraftState;
  readonly onClose: () => void;
}) {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const { handleNewThread } = useHandleNewThread();
  const createProject = useAtomCommand(projectEnvironment.create);
  const [state, dispatch] = useReducer(reduceCreateProjectDraft, props.initial);

  const environment = environments.find(
    (candidate) => candidate.environmentId === state.environmentId,
  );
  const platform = browsePlatformOf(environment?.serverConfig?.environment.platform.os);
  const connectableEnvironments = environments.filter((candidate) =>
    canCreateProjectInEnvironment(candidate.connection.phase),
  );

  const validation = validateCreateProjectDraft(state, {
    projects,
    platform,
    currentProjectCwd: null,
    environmentConnected: canCreateProjectInEnvironment(environment?.connection.phase),
    environmentLabel: environment?.label ?? null,
  });

  const addFolder = useCallback((rawPath?: string) => {
    dispatch({ _tag: "AddFolder", id: makeFolderId(), ...(rawPath ? { rawPath } : {}) });
  }, []);

  // Desktop only: the native picker returns one folder per invocation, so each
  // click appends a row rather than accepting a multi-selection.
  const canPickNatively = typeof window !== "undefined" && window.desktopBridge !== undefined;
  const pickFolder = useCallback(async () => {
    const api = readLocalApi();
    if (!api) return;
    try {
      const picked = await api.dialogs.pickFolder();
      if (picked) addFolder(picked);
    } catch {
      // Leave the dialog open; the user can still type a path.
    }
  }, [addFolder]);

  const submit = async () => {
    if (!validation.ok || state.isSubmitting) return;
    dispatch({ _tag: "SetSubmitting", isSubmitting: true });
    const projectId = newProjectId();
    const result = await createProject({
      environmentId: validation.environmentId,
      input: {
        projectId,
        title: validation.title,
        workspaceRoot: validation.primaryPath,
        ...(validation.additionalPaths.length > 0
          ? { additionalFolders: validation.additionalPaths.map((path) => ({ path })) }
          : {}),
        createWorkspaceRootIfMissing: true,
      },
    });
    dispatch({ _tag: "SetSubmitting", isSubmitting: false });

    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Failed to create project",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      return;
    }

    props.onClose();
    await handleNewThread(scopeProjectRef(validation.environmentId, projectId));
  };

  const showErrors = state.name.trim().length > 0 || state.folders.length > 0;
  const folderErrors =
    validation.ok || !showErrors ? new Map<string, string>() : validation.folderErrors;
  const primaryId = state.primaryFolderId ?? state.folders[0]?.id ?? null;
  const showPrimarySelector = state.folders.length > 1;

  return (
    <DialogPopup className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Create project</DialogTitle>
        <DialogDescription>
          Name the project and choose the folders T3 Code can read and edit.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="grid gap-5">
        {connectableEnvironments.length > 1 ? (
          <label className="grid gap-1.5">
            <span className="font-medium text-foreground text-sm">Environment</span>
            <Select
              value={state.environmentId ?? ""}
              onValueChange={(value) =>
                dispatch({ _tag: "SetEnvironment", environmentId: value as EnvironmentId })
              }
            >
              <SelectTrigger aria-label="Environment">
                <SelectValue>{environment?.label ?? "Choose an environment"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {connectableEnvironments.map((candidate) => (
                  <SelectItem key={candidate.environmentId} value={candidate.environmentId}>
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
        ) : null}

        <label className="grid gap-1.5">
          <span className="font-medium text-foreground text-sm">Project name</span>
          <Input
            autoFocus
            aria-label="Project name"
            value={state.name}
            placeholder="my-app"
            onChange={(event) => dispatch({ _tag: "SetName", name: event.currentTarget.value })}
          />
          {showErrors && !validation.ok && validation.nameError ? (
            <span className="text-destructive text-xs">{validation.nameError}</span>
          ) : null}
        </label>

        <div className="grid gap-2">
          <span className="font-medium text-foreground text-sm">Source folders</span>
          {state.folders.length === 0 ? (
            <div className="grid justify-items-center gap-3 rounded-md border border-input border-dashed py-6">
              <FolderPlusIcon className="size-5 opacity-60" />
              <p className="text-muted-foreground text-sm">Add folders T3 Code can read and edit</p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => addFolder()}>
                  Add folder
                </Button>
                {canPickNatively ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void pickFolder()}
                  >
                    Browse…
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <>
              <RadioGroup
                className="gap-2"
                value={primaryId ?? ""}
                onValueChange={(value) => dispatch({ _tag: "MakePrimary", id: String(value) })}
              >
                {state.folders.map((folder) => (
                  <div key={folder.id} className="contents">
                    <SourceFolderRow
                      folderId={folder.id}
                      environmentId={state.environmentId}
                      value={folder.rawPath}
                      isPrimary={folder.id === primaryId}
                      showPrimarySelector={showPrimarySelector}
                      canRemove={state.folders.length > 1}
                      error={folderErrors.get(folder.id) ?? null}
                      onChange={(next) =>
                        dispatch({ _tag: "UpdateFolder", id: folder.id, rawPath: next })
                      }
                      onRemove={() => dispatch({ _tag: "RemoveFolder", id: folder.id })}
                    />
                  </div>
                ))}
              </RadioGroup>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => addFolder()}>
                  <PlusIcon className="size-3.5" /> Add folder
                </Button>
                {canPickNatively ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => void pickFolder()}>
                    Browse…
                  </Button>
                ) : null}
              </div>
              {showPrimarySelector ? (
                <p className="text-muted-foreground text-xs">
                  New threads and terminals start in the primary folder. The agent can read and edit
                  all of them.
                </p>
              ) : null}
            </>
          )}
        </div>

        {showErrors && !validation.ok && validation.formError ? (
          <p className="text-destructive text-xs">{validation.formError}</p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={props.onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={!validation.ok || state.isSubmitting}
          onClick={() => void submit()}
        >
          Create project
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

/**
 * Mounted once at the route root: both sidebars and the empty-state hero open
 * it, and it must outlive the sidebar unmounting underneath it.
 */
export function CreateProjectDialog() {
  const { environments } = useEnvironments();
  const [initial, setInitial] = useState<CreateProjectDraftState | null>(null);
  const environmentsRef = useRef(environments);
  environmentsRef.current = environments;

  useEffect(
    () =>
      onOpenCreateProjectDialog((detail) => {
        const fallback = environmentsRef.current.find((candidate) =>
          canCreateProjectInEnvironment(candidate.connection.phase),
        );
        setInitial(
          createProjectDraftInitialState({
            environmentId: detail.environmentId ?? fallback?.environmentId ?? null,
            folderId: makeFolderId(),
            ...(detail.initialFolderPath !== undefined
              ? { initialFolderPath: detail.initialFolderPath }
              : {}),
          }),
        );
      }),
    [],
  );

  const close = useCallback(() => setInitial(null), []);

  return (
    <Dialog open={initial !== null} onOpenChange={(open) => (open ? undefined : close())}>
      {initial !== null ? <CreateProjectDialogContent initial={initial} onClose={close} /> : null}
    </Dialog>
  );
}
