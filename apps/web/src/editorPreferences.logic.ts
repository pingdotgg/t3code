import { EDITORS, type EditorId, type EnvironmentId } from "@t3tools/contracts";
import { derivePhysicalProjectKeyFromPath } from "@t3tools/client-runtime/state/project-grouping";

export interface EditorPreferences {
  /** Editor a project without an override opens in. */
  readonly defaultEditor: EditorId | null;
  /** Per-project editors, keyed by physical project key. */
  readonly projectEditorOverrides: Readonly<Record<string, EditorId>>;
}

/**
 * Project override first, then the global default, then whichever editor the
 * environment reports first. An override or default the environment no longer
 * offers falls through rather than leaving a dead "Open" button.
 */
export function resolveEditorForProject(input: {
  readonly preferences: EditorPreferences;
  readonly projectKey: string | null;
  readonly availableEditors: ReadonlyArray<EditorId>;
}): EditorId | null {
  const available = new Set(input.availableEditors);
  const override = input.projectKey
    ? input.preferences.projectEditorOverrides[input.projectKey]
    : undefined;
  if (override && available.has(override)) return override;
  const fallback = input.preferences.defaultEditor;
  if (fallback && available.has(fallback)) return fallback;
  return EDITORS.find((editor) => available.has(editor.id))?.id ?? null;
}

export function nextProjectEditorOverrides(input: {
  readonly overrides: Readonly<Record<string, EditorId>>;
  readonly projectKey: string;
  readonly editor: EditorId | null;
}): Record<string, EditorId> {
  const next = { ...input.overrides };
  if (input.editor === null) {
    delete next[input.projectKey];
  } else {
    next[input.projectKey] = input.editor;
  }
  return next;
}

/** Physical project key for a project, matching sidebar grouping/color overrides. */
export function editorProjectKey(
  project: { readonly environmentId: EnvironmentId; readonly workspaceRoot: string } | null,
): string | null {
  return project
    ? derivePhysicalProjectKeyFromPath(project.environmentId, project.workspaceRoot)
    : null;
}
