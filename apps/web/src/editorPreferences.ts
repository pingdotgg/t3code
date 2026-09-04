import { EDITORS, EditorId, EnvironmentId } from "@t3tools/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  getLocalStorageItem,
  setLocalStorageItemAndNotify,
  useLocalStorage,
} from "./hooks/useLocalStorage";
import { useCallback, useMemo } from "react";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";

const LAST_EDITOR_KEY = "t3code:last-editor";

export class PreferredEditorEnvironmentRequiredError extends Schema.TaggedErrorClass<PreferredEditorEnvironmentRequiredError>()(
  "PreferredEditorEnvironmentRequiredError",
  {
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot open ${this.targetPath} because no environment is selected.`;
  }
}

export class PreferredEditorUnavailableError extends Schema.TaggedErrorClass<PreferredEditorUnavailableError>()(
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

export function resolveAndPersistPreferredEditor(
  availableEditors: readonly EditorId[],
  editorOverride?: EditorId | null,
): EditorId | null {
  const availableEditorIds = new Set(availableEditors);
  const stored = getLocalStorageItem(LAST_EDITOR_KEY, EditorId);
  const editor =
    editorOverride === undefined
      ? stored && availableEditorIds.has(stored)
        ? stored
        : (EDITORS.find((candidate) => availableEditorIds.has(candidate.id))?.id ?? null)
      : editorOverride !== null && availableEditorIds.has(editorOverride)
        ? editorOverride
        : null;
  if (editor && editor !== stored) {
    setLocalStorageItemAndNotify(LAST_EDITOR_KEY, editor, EditorId);
  }
  return editor ?? null;
}

export function useOpenInPreferredEditor(
  environmentId: EnvironmentId | null,
  availableEditors: readonly EditorId[],
) {
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  type OpenInEditorError = AtomCommandFailure<Awaited<ReturnType<typeof openInEditor>>>;

  return useCallback(
    async (
      targetPath: string,
      editorOverride?: EditorId | null,
    ): Promise<
      AtomCommandResult<
        EditorId,
        | OpenInEditorError
        | PreferredEditorEnvironmentRequiredError
        | PreferredEditorUnavailableError
      >
    > => {
      if (environmentId === null) {
        return AsyncResult.failure(
          Cause.fail(
            new PreferredEditorEnvironmentRequiredError({
              targetPath,
            }),
          ),
        );
      }
      const editor = resolveAndPersistPreferredEditor(availableEditors, editorOverride);
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
    },
    [availableEditors, environmentId, openInEditor],
  );
}
