import {
  buildRemoteOpenUrl,
  buildWslOpenUrl,
  EDITORS,
  EditorId,
  EnvironmentId,
  WSL_CAPABLE_EDITOR_IDS,
  ProjectReadFileError,
} from "@t3tools/contracts";
import {
  formatFilePathPosition,
  splitFilePathPosition,
  type FilePathPosition,
} from "@t3tools/client-runtime/markdown-links";
import {
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useLocalStorage } from "./hooks/useLocalStorage";
import { useCallback, useMemo } from "react";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { useAtomQueryRunner } from "./state/use-atom-query-runner";
import { projectEnvironment } from "./state/projects";
import { openRemoteEditorUrl, useRemoteCapableEditors, useRemoteOpenState } from "./remoteOpen";

const LAST_EDITOR_KEY = "t3code:last-editor";
const isProjectReadFileError = Schema.is(ProjectReadFileError);

export class PreferredEditorEnvironmentRequiredError extends Schema.TaggedError<PreferredEditorEnvironmentRequiredError>()(
  "PreferredEditorEnvironmentRequiredError",
  {
    targetPath: Schema.String,
  },
) {
  /** Identifies the target when routing cannot start without a selected environment. */
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
  /** Reports the target and environment when the effective route offers no usable editor. */
  override get message(): string {
    return `No available editor can open ${this.targetPath} in environment ${this.environmentId}.`;
  }
}

export class PreferredEditorLaunchError extends Schema.TaggedError<PreferredEditorLaunchError>()(
  "PreferredEditorLaunchError",
  { editor: EditorId, targetPath: Schema.String },
) {
  /** Identifies the editor and target when constructing or handing off its URL fails. */
  override get message(): string {
    return `Could not open ${this.targetPath} in ${this.editor}.`;
  }
}

/** Uses the last chosen editor when available, otherwise the editor catalog's order. */
export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, EditorId);

  const effectiveEditor = useMemo(() => {
    if (lastEditor && availableEditors.includes(lastEditor)) return lastEditor;
    return EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null;
  }, [lastEditor, availableEditors]);

  return [effectiveEditor, setLastEditor] as const;
}

/**
 * Shares editor selection and local, SSH, or WSL launch routing across entry
 * points. Launches return typed failures and remember the editor only after
 * the server or URL handler accepts the request.
 */
export function useEditorOpening(
  environmentId: EnvironmentId | null,
  availableEditors: readonly EditorId[],
) {
  const remote = useRemoteOpenState(environmentId);
  const remoteCapableEditors = useRemoteCapableEditors();

  const effectiveEditors = useMemo(
    /** Uses environment CLIs for local execution and client-supported editors for remote links. */
    function effectiveEditors() {
      if (remote.mode === "local-exec") return availableEditors;
      if (remote.mode === "remote-unavailable") return [];
      return remote.host.kind === "wsl"
        ? remoteCapableEditors.filter((editor) => WSL_CAPABLE_EDITOR_IDS.includes(editor))
        : remoteCapableEditors;
    },
    [availableEditors, remote, remoteCapableEditors],
  );
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(effectiveEditors);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const readFile = useAtomQueryRunner(projectEnvironment.readFile, {
    reportFailure: false,
    refresh: true,
  });
  type OpenInEditorError = AtomCommandFailure<Awaited<ReturnType<typeof openInEditor>>>;
  type ReadFileError = AtomCommandFailure<Awaited<ReturnType<typeof readFile>>>;

  const openEditor = useCallback(
    /**
     * Opens a directory by default. Use file for known files or auto for terminal
     * paths; WSL auto targets query the literal path before interpreting a suffix.
     * Known file paths are literal; callers with a line position pass it separately.
     */
    async function openEditor(
      targetPath: string,
      requestedEditor?: EditorId,
      targetKind: "file" | "directory" | "auto" = "directory",
      position?: Omit<FilePathPosition, "path">,
    ): Promise<
      AtomCommandResult<
        EditorId,
        | OpenInEditorError
        | ReadFileError
        | PreferredEditorEnvironmentRequiredError
        | PreferredEditorUnavailableError
        | PreferredEditorLaunchError
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
      const editor = requestedEditor ?? preferredEditor;
      if (!editor || !effectiveEditors.includes(editor)) {
        return AsyncResult.failure(
          Cause.fail(
            new PreferredEditorUnavailableError({
              environmentId,
              targetPath,
              availableEditorIds: effectiveEditors,
            }),
          ),
        );
      }
      if (remote.mode === "remote-links") {
        let isFile = targetKind === "file";
        let fileTarget = { path: targetPath, ...position };
        if (remote.host.kind === "wsl" && targetKind === "auto") {
          if (fileTarget.line !== undefined) {
            isFile = true;
          } else {
            // Prefer an existing literal path. Only a confirmed missing path
            // permits interpreting its numeric suffix as a line position.
            let result = await readFile({
              environmentId,
              input: { cwd: "/", relativePath: fileTarget.path },
            });
            if (result._tag === "Failure" && position === undefined) {
              const error = squashAtomCommandFailure(result);
              const parsedTarget = splitFilePathPosition(targetPath);
              if (
                isProjectReadFileError(error) &&
                error.pathNotFound === true &&
                parsedTarget.line !== undefined
              ) {
                fileTarget = parsedTarget;
                result = await readFile({
                  environmentId,
                  input: { cwd: "/", relativePath: fileTarget.path },
                });
              }
            }
            if (result._tag === "Success") {
              isFile = true;
            } else {
              const error = squashAtomCommandFailure(result);
              if (isProjectReadFileError(error) && error.failure === "path_not_file") {
                isFile = false;
              } else if (isProjectReadFileError(error) && error.failure === "binary_file") {
                isFile = true;
              } else {
                return mapAtomCommandResult(result, () => editor);
              }
            }
          }
        }
        const url =
          remote.host.kind === "wsl"
            ? buildWslOpenUrl({
                editor,
                distro: remote.host.host,
                absolutePath: fileTarget.path,
                isFile,
                position: fileTarget,
              })
            : buildRemoteOpenUrl({
                editor,
                host: remote.host.host,
                absolutePath: formatFilePathPosition({ path: targetPath, ...position }),
              });
        if (url === undefined || !(await openRemoteEditorUrl(url))) {
          return AsyncResult.failure(
            Cause.fail(new PreferredEditorLaunchError({ editor, targetPath })),
          );
        }
        setPreferredEditor(editor);
        return AsyncResult.success(editor);
      }
      const result = await openInEditor({
        environmentId,
        input: {
          cwd: formatFilePathPosition({ path: targetPath, ...position }),
          editor,
        },
      });
      if (result._tag === "Success") setPreferredEditor(editor);
      return mapAtomCommandResult(result, () => editor);
    },
    [
      effectiveEditors,
      environmentId,
      openInEditor,
      preferredEditor,
      remote,
      setPreferredEditor,
      readFile,
    ],
  );

  return { remote, availableEditors: effectiveEditors, preferredEditor, openEditor };
}

/** Known files open directly; arbitrary terminal paths use auto classification in WSL. */
export function useOpenInPreferredEditor(
  environmentId: EnvironmentId | null,
  availableEditors: readonly EditorId[],
) {
  const { openEditor } = useEditorOpening(environmentId, availableEditors);
  return useCallback(
    (targetPath: string, targetKind: "file" | "directory" | "auto" = "file") =>
      openEditor(targetPath, undefined, targetKind),
    [openEditor],
  );
}
