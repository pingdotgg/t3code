/**
 * Pure state and validation for the create-project dialog.
 *
 * Kept out of the component so the interesting behaviour — auto-derived names,
 * primary reassignment on removal, duplicate detection — is unit-testable.
 *
 * @module CreateProjectDialog.logic
 */
import {
  findExistingAddProject,
  resolveAddProjectPath,
} from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import { inferProjectTitleFromPath } from "~/lib/projectPaths";

export interface SourceFolderDraft {
  /** Stable React key, kept across promote/remove so rows do not remount. */
  readonly id: string;
  /** Exactly what the user typed or picked, before resolution. */
  readonly rawPath: string;
}

export interface CreateProjectDraftState {
  readonly environmentId: EnvironmentId | null;
  readonly name: string;
  /** Once the user edits the name, stop re-deriving it from the primary folder. */
  readonly nameTouched: boolean;
  readonly folders: ReadonlyArray<SourceFolderDraft>;
  readonly primaryFolderId: string | null;
  readonly isSubmitting: boolean;
}

export type CreateProjectDraftAction =
  | { readonly _tag: "SetEnvironment"; readonly environmentId: EnvironmentId }
  | { readonly _tag: "SetName"; readonly name: string }
  | { readonly _tag: "AddFolder"; readonly id: string; readonly rawPath?: string }
  | { readonly _tag: "UpdateFolder"; readonly id: string; readonly rawPath: string }
  | { readonly _tag: "RemoveFolder"; readonly id: string }
  | { readonly _tag: "MakePrimary"; readonly id: string }
  | { readonly _tag: "SetSubmitting"; readonly isSubmitting: boolean };

export function createProjectDraftInitialState(input?: {
  readonly environmentId?: EnvironmentId | null;
  readonly folderId?: string;
  readonly initialFolderPath?: string;
}): CreateProjectDraftState {
  const seeded =
    input?.initialFolderPath !== undefined && input.folderId !== undefined
      ? [{ id: input.folderId, rawPath: input.initialFolderPath }]
      : [];
  return {
    environmentId: input?.environmentId ?? null,
    name: seeded[0] ? inferProjectTitleFromPath(seeded[0].rawPath) : "",
    nameTouched: false,
    folders: seeded,
    primaryFolderId: seeded[0]?.id ?? null,
    isSubmitting: false,
  };
}

function deriveName(
  state: CreateProjectDraftState,
  folders: ReadonlyArray<SourceFolderDraft>,
  primaryFolderId: string | null,
): string {
  if (state.nameTouched) return state.name;
  const primary = folders.find((folder) => folder.id === primaryFolderId) ?? folders[0];
  const rawPath = primary?.rawPath.trim() ?? "";
  return rawPath.length === 0 ? "" : inferProjectTitleFromPath(rawPath);
}

export function reduceCreateProjectDraft(
  state: CreateProjectDraftState,
  action: CreateProjectDraftAction,
): CreateProjectDraftState {
  switch (action._tag) {
    case "SetEnvironment": {
      if (action.environmentId === state.environmentId) return state;
      // Paths are environment-scoped: silently carrying a macOS path into a WSL
      // environment is exactly the wrong-path footgun the palette guards against.
      return {
        ...state,
        environmentId: action.environmentId,
        folders: [],
        primaryFolderId: null,
        name: state.nameTouched ? state.name : "",
      };
    }
    case "SetName": {
      const derived = deriveName(
        { ...state, nameTouched: false },
        state.folders,
        state.primaryFolderId,
      );
      return {
        ...state,
        name: action.name,
        // Typing the derived value back in re-enables auto-derivation, so the
        // user can undo an edit without reopening the dialog.
        nameTouched: action.name.trim() !== derived.trim(),
      };
    }
    case "AddFolder": {
      const folders = [...state.folders, { id: action.id, rawPath: action.rawPath ?? "" }];
      const primaryFolderId = state.primaryFolderId ?? action.id;
      return {
        ...state,
        folders,
        primaryFolderId,
        name: deriveName(state, folders, primaryFolderId),
      };
    }
    case "UpdateFolder": {
      const folders = state.folders.map((folder) =>
        folder.id === action.id ? { ...folder, rawPath: action.rawPath } : folder,
      );
      return { ...state, folders, name: deriveName(state, folders, state.primaryFolderId) };
    }
    case "RemoveFolder": {
      const folders = state.folders.filter((folder) => folder.id !== action.id);
      // Removing the primary promotes whatever is left rather than leaving the
      // draft with no primary at all.
      const primaryFolderId =
        state.primaryFolderId === action.id ? (folders[0]?.id ?? null) : state.primaryFolderId;
      return {
        ...state,
        folders,
        primaryFolderId,
        name: deriveName(state, folders, primaryFolderId),
      };
    }
    case "MakePrimary": {
      if (!state.folders.some((folder) => folder.id === action.id)) return state;
      return {
        ...state,
        primaryFolderId: action.id,
        name: deriveName(state, state.folders, action.id),
      };
    }
    case "SetSubmitting":
      return { ...state, isSubmitting: action.isSubmitting };
  }
}

export interface CreateProjectDraftValid {
  readonly ok: true;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly primaryPath: string;
  readonly additionalPaths: ReadonlyArray<string>;
}

export interface CreateProjectDraftInvalid {
  readonly ok: false;
  readonly nameError: string | null;
  readonly folderErrors: ReadonlyMap<string, string>;
  readonly formError: string | null;
  /** Set when the primary folder already belongs to a project the user could open. */
  readonly existingProjectId: string | null;
}

export type CreateProjectDraftValidation = CreateProjectDraftValid | CreateProjectDraftInvalid;

export function validateCreateProjectDraft(
  state: CreateProjectDraftState,
  context: {
    readonly projects: ReadonlyArray<EnvironmentProject>;
    readonly platform: string;
    readonly currentProjectCwd: string | null;
    readonly environmentConnected: boolean;
    readonly environmentLabel: string | null;
  },
): CreateProjectDraftValidation {
  const folderErrors = new Map<string, string>();
  let formError: string | null = null;
  const nameError = state.name.trim().length === 0 ? "Enter a project name." : null;

  if (state.environmentId === null) {
    formError = "Choose an environment.";
  } else if (!context.environmentConnected) {
    formError = `${context.environmentLabel ?? "This environment"} is not connected.`;
  } else if (state.folders.length === 0) {
    formError = "Add at least one source folder.";
  }

  const resolved = new Map<string, string>();
  const seen = new Map<string, string>();
  for (const folder of state.folders) {
    const result = resolveAddProjectPath({
      rawPath: folder.rawPath,
      currentProjectCwd: context.currentProjectCwd,
      platform: context.platform,
    });
    if (!result.ok) {
      // A freshly added, still-empty row is incomplete, not wrong — the submit
      // gate still blocks on it via the missing resolved path below.
      if (folder.rawPath.trim().length > 0) folderErrors.set(folder.id, result.error);
      continue;
    }
    const key = normalizeProjectPathForComparison(result.path);
    if (seen.has(key)) {
      folderErrors.set(folder.id, "This folder is already added.");
      continue;
    }
    seen.set(key, folder.id);
    resolved.set(folder.id, result.path);
  }

  // An empty row is not flagged inline (it is merely unfinished), but it must
  // still block submit — otherwise it would be silently dropped and the user
  // would get a project without the folder they meant to add.
  const hasEmptyRow = state.folders.some((folder) => folder.rawPath.trim().length === 0);
  if (formError === null && hasEmptyRow) {
    formError = "Enter a path for every source folder.";
  }

  const primaryId = state.primaryFolderId ?? state.folders[0]?.id ?? null;
  const primaryPath = primaryId === null ? undefined : resolved.get(primaryId);

  // Folders are shareable across projects, so an existing owner is surfaced as
  // context (the caller can offer to open it instead) rather than an error.
  let existingProjectId: string | null = null;
  if (state.environmentId !== null && primaryPath !== undefined) {
    existingProjectId =
      findExistingAddProject({
        projects: context.projects,
        environmentId: state.environmentId,
        path: primaryPath,
      })?.id ?? null;
  }

  if (
    nameError !== null ||
    formError !== null ||
    folderErrors.size > 0 ||
    state.environmentId === null ||
    primaryPath === undefined
  ) {
    return { ok: false, nameError, folderErrors, formError, existingProjectId };
  }

  return {
    ok: true,
    environmentId: state.environmentId,
    title: state.name.trim(),
    primaryPath,
    additionalPaths: state.folders
      .filter((folder) => folder.id !== primaryId)
      .map((folder) => resolved.get(folder.id))
      .filter((path): path is string => path !== undefined),
  };
}
