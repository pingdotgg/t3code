/**
 * Right-click actions for a workspace file: reveal it in the environment's
 * file manager and open it in an editor. Reuse the chat file-chip menu's
 * machinery: reveal rides `shell.openInEditor` with `reveal: true`, which the
 * server only honors when its `shellRevealInFileManager` config flag is set,
 * so both actions work for every client and connection mode.
 */
import {
  EDITORS,
  type ContextMenuItem,
  type EditorId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { resolveDiffPathForWorkspace } from "./diffFileActions";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "~/components/preview/fileExplorerLabel";
import { readLocalApi } from "./localApi";
import { serverEnvironment } from "./state/server";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { resolvePathLinkTarget } from "./terminal-links";
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
}

/** Absolute path on the environment host, or null when it cannot be resolved. */
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

const EDITOR_LABEL_BY_ID = new Map(EDITORS.map((editor) => [editor.id, editor.label]));

export interface FileContextMenuCapabilities {
  readonly revealLabel: string | undefined;
  readonly canOpenDefault: boolean;
  readonly editorIds: ReadonlyArray<EditorId>;
}

export function buildFileContextMenuItems(input: {
  readonly hasAbsolutePath: boolean;
  readonly capabilities: FileContextMenuCapabilities;
}): readonly ContextMenuItem<FileContextMenuAction>[] {
  // Without a resolvable absolute path nothing here can act on the file.
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

/**
 * Context-menu actions for files. The environment id is fixed per component
 * (a thread's environment, a file browser's environment), so capabilities
 * resolve once per hook call.
 */
export function useFileContextMenu(environmentId: EnvironmentId | null) {
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));

  return useMemo(() => {
    const availableEditors = serverConfig?.availableEditors ?? [];
    const capabilities: FileContextMenuCapabilities = {
      // The reveal wording comes from the server because on WSL the reveal can
      // run through Windows File Explorer even though the host reports Linux.
      revealLabel:
        environmentId !== null &&
        serverConfig?.shellRevealInFileManager === true &&
        serverConfig.availableEditors.includes("file-manager")
          ? serverConfig.shellRevealInFileManagerKind === undefined
            ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os)
            : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind)
          : undefined,
      canOpenDefault: availableEditors.includes("file-manager"),
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

    return {
      buildItems: (target: FileContextMenuTarget) =>
        buildFileContextMenuItems({
          hasAbsolutePath: resolveFileContextMenuAbsolutePath(target) !== null,
          capabilities,
        }),
      capabilities,
      activate,
      show,
    };
  }, [environmentId, openInEditor, serverConfig]);
}

/** Convenience callback for onContextMenu handlers. */
export function useFileContextMenuHandler(environmentId: EnvironmentId | null) {
  const contextMenu = useFileContextMenu(environmentId);
  return useCallback(
    (target: FileContextMenuTarget, event?: { clientX: number; clientY: number }) => {
      void contextMenu.show(target, event ? { x: event.clientX, y: event.clientY } : undefined);
    },
    [contextMenu],
  );
}
