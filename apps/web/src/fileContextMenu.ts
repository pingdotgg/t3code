import {
  buildRemoteOpenUrl,
  EDITORS,
  remoteSchemeForEditor,
  type ContextMenuItem,
  type EditorId,
  type EnvironmentId,
} from "@t3tools/contracts";

import { resolveDiffPathForWorkspace } from "./diffFileActions";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "~/components/preview/fileExplorerLabel";
import { usePreferredEditor } from "./editorPreferences";
import { readLocalApi } from "./localApi";
import { openRemoteEditorUrl, useRemoteCapableEditors, useRemoteOpenState } from "./remoteOpen";
import { serverEnvironment } from "./state/server";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { isTerminalLinkActivation } from "./terminal-links";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { toastManager } from "./components/ui/toast";
import { useAtomValue } from "@effect/atom-react";

export type FileContextMenuAction =
  | "reveal-in-folder"
  | "open"
  /** Submenu parent; never the activated id. */
  | "open-with"
  | `editor:${EditorId}`;

export interface FileContextMenuTarget {
  readonly environmentId: EnvironmentId | null;
  /** Repo- or workspace-relative file path, as shown in diffs. */
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot?: string | undefined;
  readonly isDirectory?: boolean;
}

export function resolveFileContextMenuAbsolutePath(target: FileContextMenuTarget): string | null {
  const workspaceFilePath = resolveDiffPathForWorkspace({
    filePath: target.filePath,
    workspaceRoot: target.workspaceRoot,
    repositoryRoot: target.repositoryRoot,
  });
  if (workspaceFilePath === null) return null;
  if (target.workspaceRoot === undefined) {
    return workspaceFilePath.startsWith("/") || /^[a-zA-Z]:/.test(workspaceFilePath)
      ? workspaceFilePath
      : null;
  }
  return resolvePathLinkTarget(workspaceFilePath, target.workspaceRoot);
}

export type FileModifierClickAction = "open-in-editor" | "reveal";

/**
 * Mod-click opens the preferred editor, matching chat and terminal links, and
 * Mod+Alt-click reveals in the file manager. Trees that use Mod-click for
 * multi-select take Mod+Shift-click for the editor instead.
 */
export function resolveFileModifierClickAction(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  options: { readonly modClickSelects: boolean },
  platform?: string,
): FileModifierClickAction | null {
  if (!isTerminalLinkActivation(event, platform)) return null;
  if (event.altKey) return event.shiftKey ? null : "reveal";
  return event.shiftKey === options.modClickSelects ? "open-in-editor" : null;
}

const EDITOR_LABEL_BY_ID = new Map(EDITORS.map((editor) => [editor.id, editor.label]));

export interface FileContextMenuCapabilities {
  readonly revealLabel: string | undefined;
  readonly canOpenDefault: boolean;
  readonly editorIds: ReadonlyArray<EditorId>;
}

function buildFileContextMenuItems(input: {
  readonly hasAbsolutePath: boolean;
  readonly capabilities: FileContextMenuCapabilities;
}): readonly ContextMenuItem<FileContextMenuAction>[] {
  if (!input.hasAbsolutePath) return [];
  const items: ContextMenuItem<FileContextMenuAction>[] = [];
  if (input.capabilities.canOpenDefault) {
    items.push({ id: "open", label: "Open", icon: "pencil" });
  }
  if (input.capabilities.revealLabel !== undefined) {
    items.push({
      id: "reveal-in-folder",
      label: input.capabilities.revealLabel,
      icon: "folder-tree",
    });
  }
  const editorIds = input.capabilities.editorIds.filter((id) => id !== "file-manager");
  if (editorIds.length > 0) {
    items.push({
      id: "open-with",
      label: "Open with",
      children: editorIds.map((editorId) => ({
        id: `editor:${editorId}` as FileContextMenuAction,
        label: EDITOR_LABEL_BY_ID.get(editorId) ?? editorId,
      })),
    });
  }
  return items;
}

export function useFileContextMenu(environmentId: EnvironmentId | null) {
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));

  const remote = useRemoteOpenState(environmentId);
  const remoteCapableEditors = useRemoteCapableEditors();
  const isLocal = remote.mode === "local-exec";
  // Away from the server's machine, editors open over SSH on this machine, which
  // only works for editors with a remote URL scheme and can't reveal files.
  // JetBrains SSH URLs open projects rather than individual files.
  const availableEditors = isLocal
    ? (serverConfig?.availableEditors ?? [])
    : remote.mode === "remote-links"
      ? remoteCapableEditors.filter((id) => remoteSchemeForEditor(id) !== "jetbrains")
      : [];
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const capabilities: FileContextMenuCapabilities = {
    // WSL can reveal in Windows Explorer despite reporting Linux; use server wording.
    revealLabel:
      isLocal &&
      environmentId !== null &&
      serverConfig?.shellRevealInFileManager === true &&
      serverConfig.availableEditors.includes("file-manager")
        ? serverConfig.shellRevealInFileManagerKind === undefined
          ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os)
          : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind)
        : undefined,
    canOpenDefault: isLocal && availableEditors.includes("file-manager"),
    editorIds: availableEditors,
  };

  const activate = async (
    action: FileContextMenuAction,
    target: FileContextMenuTarget,
  ): Promise<void> => {
    const absolutePath = resolveFileContextMenuAbsolutePath(target);
    if (absolutePath === null || environmentId === null) return;

    const reveal = action === "reveal-in-folder";
    const editor =
      action === "open" || reveal
        ? ("file-manager" as const)
        : (action.slice("editor:".length) as EditorId);
    if (action !== "open" && !reveal && !capabilities.editorIds.includes(editor)) return;

    if (remote.mode === "remote-links") {
      const url = buildRemoteOpenUrl({
        editor,
        ...remote.host,
        absolutePath,
        isFile: target.isDirectory !== true,
      });
      if (url !== undefined && (await openRemoteEditorUrl(url))) return;
      toastManager.add({
        type: "error",
        title: `Could not open in ${EDITOR_LABEL_BY_ID.get(editor) ?? editor}`,
        description: absolutePath,
      });
      return;
    }

    const result = await openInEditor({
      environmentId,
      input: { cwd: absolutePath, editor, ...(reveal ? { reveal: true } : {}) },
    });
    if (result._tag !== "Failure") return;
    toastManager.add({
      type: "error",
      title:
        action === "open"
          ? "Could not open file"
          : reveal
            ? "Unable to reveal file"
            : `Could not open in ${EDITOR_LABEL_BY_ID.get(editor) ?? editor}`,
      description: absolutePath,
    });
  };

  const show = async (
    target: FileContextMenuTarget,
    position?: { x: number; y: number },
  ): Promise<void> => {
    const api = readLocalApi();
    const items = buildFileContextMenuItems({
      hasAbsolutePath: resolveFileContextMenuAbsolutePath(target) !== null,
      capabilities,
    });
    if (items.length === 0 || api === undefined) return;
    const clicked = await api.contextMenu.show(items, position);
    if (clicked === null) return;
    await activate(clicked as FileContextMenuAction, target);
  };

  /** Returns false when the action is unavailable, so the caller can fall back to a plain click. */
  const activateModifierClick = (
    action: FileModifierClickAction,
    target: FileContextMenuTarget,
  ): boolean => {
    const menuAction: FileContextMenuAction | null =
      action === "reveal"
        ? capabilities.revealLabel === undefined
          ? null
          : "reveal-in-folder"
        : preferredEditor === null
          ? null
          : `editor:${preferredEditor}`;
    if (menuAction === null || resolveFileContextMenuAbsolutePath(target) === null) return false;
    void activate(menuAction, target);
    return true;
  };

  return {
    buildItems: (target: FileContextMenuTarget) =>
      buildFileContextMenuItems({
        hasAbsolutePath: resolveFileContextMenuAbsolutePath(target) !== null,
        capabilities,
      }),
    capabilities,
    activate,
    activateModifierClick,
    show,
  };
}
