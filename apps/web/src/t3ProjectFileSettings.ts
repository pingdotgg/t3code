import {
  T3_PROJECT_FILE_SCHEMA_URL,
  type ProjectScriptIcon,
  type T3ProjectFile,
} from "@t3tools/contracts";

export interface T3ProjectFileScriptDraft {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly icon: ProjectScriptIcon;
  readonly runOnWorktreeCreate: boolean;
  readonly previewUrl: string;
  readonly autoOpenPreview: boolean;
}

export interface T3ProjectFileDraft {
  readonly schemaUrl: string;
  readonly iconPath: string;
  readonly scripts: ReadonlyArray<T3ProjectFileScriptDraft>;
}

export interface T3ProjectFileDraftState {
  readonly draft: T3ProjectFileDraft;
  readonly source: T3ProjectFileDraft;
  readonly validationError: string | null;
}

export type BuildT3ProjectFileResult =
  | { readonly ok: true; readonly file: T3ProjectFile; readonly contents: string }
  | { readonly ok: false; readonly error: string };

export function createT3ProjectFileDraft(file: T3ProjectFile | null): T3ProjectFileDraft {
  return {
    schemaUrl: file?.$schema ?? T3_PROJECT_FILE_SCHEMA_URL,
    iconPath: file?.iconPath ?? "",
    scripts: (file?.scripts ?? []).map((script, index) => ({
      id: `file-${index}`,
      name: script.name,
      command: script.command,
      icon: script.icon ?? "play",
      runOnWorktreeCreate: script.runOnWorktreeCreate ?? false,
      previewUrl: script.previewUrl ?? "",
      autoOpenPreview: script.autoOpenPreview ?? false,
    })),
  };
}

export function createEmptyT3ProjectFileScriptDraft(id = "new-action"): T3ProjectFileScriptDraft {
  return {
    id,
    name: "",
    command: "",
    icon: "play",
    runOnWorktreeCreate: false,
    previewUrl: "",
    autoOpenPreview: false,
  };
}

export function buildT3ProjectFile(draft: T3ProjectFileDraft): BuildT3ProjectFileResult {
  if (draft.scripts.length > 50) {
    return { ok: false, error: "t3.json supports at most 50 shared actions." };
  }

  const iconPath = draft.iconPath.trim();
  if (iconPath.length > 512) {
    return { ok: false, error: "The project icon path must be 512 characters or fewer." };
  }

  const scripts = [];
  for (const [index, script] of draft.scripts.entries()) {
    const name = script.name.trim();
    const command = script.command.trim();
    const previewUrl = script.previewUrl.trim();
    if (!name) {
      return { ok: false, error: `Shared action ${index + 1} needs a name.` };
    }
    if (!command) {
      return { ok: false, error: `Shared action "${name}" needs a command.` };
    }
    scripts.push({
      name,
      command,
      icon: script.icon,
      runOnWorktreeCreate: script.runOnWorktreeCreate,
      ...(previewUrl ? { previewUrl } : {}),
      autoOpenPreview: script.autoOpenPreview,
    });
  }

  const file: T3ProjectFile = {
    $schema: draft.schemaUrl.trim() || T3_PROJECT_FILE_SCHEMA_URL,
    ...(iconPath ? { iconPath } : {}),
    scripts,
  };
  return {
    ok: true,
    file,
    contents: `${JSON.stringify(file, null, 2)}\n`,
  };
}

export function updateT3ProjectFileScriptPreviewUrl(
  script: T3ProjectFileScriptDraft,
  previewUrl: string,
): T3ProjectFileScriptDraft {
  return {
    ...script,
    previewUrl,
    autoOpenPreview: previewUrl.trim().length > 0 ? script.autoOpenPreview : false,
  };
}

export function t3ProjectFileDraftKey(draft: T3ProjectFileDraft): string {
  return JSON.stringify({
    schemaUrl: draft.schemaUrl,
    iconPath: draft.iconPath,
    scripts: draft.scripts.map((script) => ({
      name: script.name,
      command: script.command,
      icon: script.icon,
      runOnWorktreeCreate: script.runOnWorktreeCreate,
      previewUrl: script.previewUrl,
      autoOpenPreview: script.autoOpenPreview,
    })),
  });
}

export function createT3ProjectFileDraftState(source: T3ProjectFileDraft): T3ProjectFileDraftState {
  return {
    draft: source,
    source,
    validationError: null,
  };
}

export function reconcileT3ProjectFileDraftState(
  current: T3ProjectFileDraftState,
  refreshedSource: T3ProjectFileDraft,
): T3ProjectFileDraftState {
  const draftKey = t3ProjectFileDraftKey(current.draft);
  const wasClean = draftKey === t3ProjectFileDraftKey(current.source);
  const refreshMatchesDraft = draftKey === t3ProjectFileDraftKey(refreshedSource);

  if (wasClean) {
    return createT3ProjectFileDraftState(refreshedSource);
  }

  if (refreshMatchesDraft) {
    return {
      draft: current.draft,
      source: refreshedSource,
      validationError: null,
    };
  }

  return {
    ...current,
    source: refreshedSource,
  };
}
