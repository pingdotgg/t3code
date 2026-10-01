import { EDITORS, EditorId, EnvironmentId } from "@t3tools/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { useCallback, useMemo } from "react";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";

const LAST_EDITOR_KEY = "t3code:last-editor";

export class PreferredEditorEnvironmentRequiredError extends Schema.TaggedError<PreferredEditorEnvironmentRequiredError>()(
  "PreferredEditorEnvironmentRequiredError",
  {
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot open ${this.targetPath} because no environment is selected.`;
  }
}

export class PreferredEditorUnavailableError extends Schema.TaggedError<PreferredEditorUnavailableError>()(
  "PreferredEditorUnavailableError",
  {
    environmentId: EnvironmentId,
    targetPath: Schema.String,
    availableEditorIds: Schema.Array(EditorId),
  },
) {
  override get message(): string {
    return `No available editor can open ${this.targetPath} in environment ${this.environmentId}.`;
  }
}

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, EditorId);

  const effectiveEditor = useMemo(() => {
    if (lastEditor && availableEditors.includes(lastEditor)) return lastEditor;
    return EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null;
  }, [lastEditor, availableEditors]);

  return [effectiveEditor, setLastEditor] as const;
}

export function resolvePreferredEditor(availableEditors: readonly EditorId[]): EditorId | null {
  const availableEditorIds = new Set(availableEditors);
  const stored = getLocalStorageItem(LAST_EDITOR_KEY, EditorId);
  if (stored && availableEditorIds.has(stored)) return stored;
  return EDITORS.find((editor) => availableEditorIds.has(editor.id))?.id ?? null;
}

export function persistPreferredEditor(editor: EditorId): void {
  setLocalStorageItem(LAST_EDITOR_KEY, editor, EditorId);
}

export function resolveAndPersistPreferredEditor(
  availableEditors: readonly EditorId[],
): EditorId | null {
  const editor = resolvePreferredEditor(availableEditors);
  if (editor && getLocalStorageItem(LAST_EDITOR_KEY, EditorId) !== editor)
    persistPreferredEditor(editor);
  return editor;
}

/**
 * Opens `targetPath` in the saved editor (or the first available one) through
 * the environment's `shell.openInEditor`. Every native link and the
 * `t3.client/editor` provider open paths through this.
 */
export async function openInPreferredEditor<E>(
  environmentId: EnvironmentId | null,
  availableEditors: readonly EditorId[],
  targetPath: string,
  openInEditor: (value: {
    environmentId: EnvironmentId;
    input: { cwd: string; editor: EditorId };
  }) => Promise<AtomCommandResult<unknown, E>>,
): Promise<
  AtomCommandResult<
    EditorId,
    E | PreferredEditorEnvironmentRequiredError | PreferredEditorUnavailableError
  >
> {
  if (environmentId === null) {
    return AsyncResult.failure(
      Cause.fail(
        new PreferredEditorEnvironmentRequiredError({
          targetPath,
        }),
      ),
    );
  }
  const editor = resolveAndPersistPreferredEditor(availableEditors);
  if (!editor) {
    return AsyncResult.failure(
      Cause.fail(
        new PreferredEditorUnavailableError({
          environmentId,
          targetPath,
          availableEditorIds: availableEditors,
        }),
      ),
    );
  }
  const result = await openInEditor({
    environmentId,
    input: {
      cwd: targetPath,
      editor,
    },
  });
  return mapAtomCommandResult(result, () => editor);
}

export function useOpenInPreferredEditor(
  environmentId: EnvironmentId | null,
  availableEditors: readonly EditorId[],
) {
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });

  return useCallback(
    (targetPath: string) =>
      openInPreferredEditor(environmentId, availableEditors, targetPath, openInEditor),
    [availableEditors, environmentId, openInEditor],
  );
}
