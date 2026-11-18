import {
  AuthOrchestrationOperateScope,
  EDITORS,
  EditorId,
  EnvironmentAuthorizationError,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { parseFileUrlHref, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { safeDecodeURIComponent } from "@t3tools/shared/markdownLinks";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { msg } from "gt-react";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { m } from "./i18n/messages";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { readEnvironmentScope } from "./state/session";
import { launchDeviceLocalEditor, useLocalEditors, useRemoteOpenState } from "./remoteOpen";

const LAST_EDITOR_KEY = "t3code:last-editor";

export class PreferredEditorEnvironmentRequiredError extends Schema.TaggedError<PreferredEditorEnvironmentRequiredError>()(
  "PreferredEditorEnvironmentRequiredError",
  {
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return m(
      msg("Cannot open {targetPath} because no environment is selected.", {
        targetPath: this.targetPath,
      }),
    );
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
    return m(
      msg("No available editor can open {targetPath} in environment {environmentId}.", {
        targetPath: this.targetPath,
        environmentId: this.environmentId,
      }),
    );
  }
}

export class DeviceLocalEditorLaunchError extends Schema.TaggedError<DeviceLocalEditorLaunchError>()(
  "DeviceLocalEditorLaunchError",
  { message: Schema.String },
) {}

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, EditorId);

  const effectiveEditor =
    lastEditor && availableEditors.includes(lastEditor)
      ? lastEditor
      : (EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null);

  return [effectiveEditor, setLastEditor] as const;
}

function resolveAndPersistPreferredEditor(availableEditors: readonly EditorId[]): EditorId | null {
  const availableEditorIds = new Set(availableEditors);
  let stored: EditorId | null = null;
  try {
    stored = getLocalStorageItem(LAST_EDITOR_KEY, EditorId);
  } catch (error) {
    console.warn("Could not read the preferred editor.", error);
  }
  if (stored && availableEditorIds.has(stored)) return stored;
  const editor = EDITORS.find((editor) => availableEditorIds.has(editor.id))?.id ?? null;
  if (editor) {
    try {
      setLocalStorageItem(LAST_EDITOR_KEY, editor, EditorId);
    } catch (error) {
      console.warn("Could not save the preferred editor.", error);
    }
  }
  return editor ?? null;
}

export function useOpenInPreferredEditor(
  environmentId: EnvironmentId | null,
  availableEditors: readonly EditorId[],
  projectRoot?: string,
) {
  const remote = useRemoteOpenState(environmentId);
  const clientEditors = useLocalEditors();
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  type OpenInEditorError = AtomCommandFailure<Awaited<ReturnType<typeof openInEditor>>>;

  return async (
    targetPath: string,
  ): Promise<
    AtomCommandResult<
      EditorId,
      | OpenInEditorError
      | PreferredEditorEnvironmentRequiredError
      | PreferredEditorUnavailableError
      | DeviceLocalEditorLaunchError
      | EnvironmentAuthorizationError
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
    if (remote.mode === "device-local") {
      const editor = resolveAndPersistPreferredEditor(clientEditors);
      if (editor) {
        const failure = await launchDeviceLocalEditor(editor, targetPath);
        return failure === null
          ? AsyncResult.success(editor)
          : AsyncResult.failure(Cause.fail(new DeviceLocalEditorLaunchError({ message: failure })));
      }
      return AsyncResult.failure(
        Cause.fail(
          new PreferredEditorUnavailableError({
            environmentId,
            targetPath,
            availableEditorIds: clientEditors,
          }),
        ),
      );
    }
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      return AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthOrchestrationOperateScope,
            message: m(msg("This connection cannot open an editor on this environment.")),
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
    const uri = /^file:\/\//iu.test(targetPath) ? parseFileUrlHref(targetPath) : null;
    const { line, column } = uri ? splitFilePathPosition("", uri.hash) : {};
    const result = await openInEditor({
      environmentId,
      input: {
        cwd: uri ? safeDecodeURIComponent(uri.path) : targetPath,
        ...(uri ? { position: { line, column } } : {}),
        editor,
        ...(projectRoot ? { projectRoot } : {}),
      },
    });
    return mapAtomCommandResult(result, () => editor);
  };
}
