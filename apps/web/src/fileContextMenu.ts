import {
  EDITORS,
  type ContextMenuItem,
  type EditorId,
  type EnvironmentId,
} from "@t3tools/contracts";

import { resolveDiffPathForWorkspace } from "./diffFileActions";
import { writeTextToClipboard } from "./hooks/useCopyToClipboard";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "~/components/preview/fileExplorerLabel";
import { readLocalApi } from "./localApi";
import { serverEnvironment } from "./state/server";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { toastManager } from "./components/ui/toast";
import { useAtomValue } from "@effect/atom-react";
import { msg, useMessages } from "gt-react";

import type { MessageResolver } from "./i18n/messages";

export type FileContextMenuAction =
  | "copy-relative-path"
  | "copy-absolute-path"
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

/**
 * Absolute path on the environment host for a diff-style target, resolving
 * repo-relative paths through the workspace root like every other diff
 * surface. Returns null when the path cannot be resolved, which callers must
 * treat as "no host file actions available".
 */
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

// A diff may include sibling projects. Copying their paths does not require host file access.
function resolveFileContextMenuAbsoluteCopyPath(target: FileContextMenuTarget): string | null {
  return (
    resolveFileContextMenuAbsolutePath(target) ??
    (target.repositoryRoot
      ? resolveFileContextMenuAbsolutePath({
          ...target,
          workspaceRoot: target.repositoryRoot,
          repositoryRoot: undefined,
        })
      : null)
  );
}

const EDITOR_LABEL_BY_ID = new Map(EDITORS.map((editor) => [editor.id, editor.label]));

export interface FileContextMenuCapabilities {
  readonly revealLabel: string | undefined;
  readonly canOpenDefault: boolean;
  readonly editorIds: ReadonlyArray<EditorId>;
}

/**
 * Copying a relative path needs no host capabilities. Absolute-path copying and
 * host file actions are offered only when the path can be resolved.
 */
export function buildFileContextMenuItems(input: {
  readonly target: FileContextMenuTarget;
  readonly capabilities: FileContextMenuCapabilities;
  readonly resolve: MessageResolver;
}): readonly ContextMenuItem<FileContextMenuAction>[] {
  const hasHostFilePath = resolveFileContextMenuAbsolutePath(input.target) !== null;
  const items: ContextMenuItem<FileContextMenuAction>[] = [];
  if (hasHostFilePath && input.capabilities.canOpenDefault) {
    items.push({
      id: "open",
      label: input.resolve(msg("Open", { $context: "verb, opens a file" })),
      icon: "pencil",
    });
  }
  if (hasHostFilePath && input.capabilities.revealLabel !== undefined) {
    items.push({
      id: "reveal-in-folder",
      label: input.capabilities.revealLabel,
      icon: "folder-tree",
    });
  }
  const editorIds = input.capabilities.editorIds.filter((id) => id !== "file-manager");
  if (hasHostFilePath && editorIds.length > 0) {
    items.push({
      id: "open-with",
      label: input.resolve(msg("Open with")),
      children: editorIds.map((editorId) => ({
        id: `editor:${editorId}` as FileContextMenuAction,
        label: EDITOR_LABEL_BY_ID.get(editorId) ?? editorId,
      })),
    });
  }
  items.push({
    id: "copy-relative-path",
    label: input.resolve(msg("Copy relative path")),
    icon: "copy",
    separatorBefore: items.length > 0,
  });
  if (resolveFileContextMenuAbsoluteCopyPath(input.target) !== null) {
    items.push({
      id: "copy-absolute-path",
      label: input.resolve(msg("Copy absolute path")),
      icon: "copy",
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
  const resolve = useMessages();

  const availableEditors = serverConfig?.availableEditors ?? [];
  const capabilities: FileContextMenuCapabilities = {
    // WSL can reveal in Windows Explorer despite reporting Linux; use server wording.
    revealLabel:
      environmentId !== null &&
      serverConfig?.shellRevealInFileManager === true &&
      serverConfig.availableEditors.includes("file-manager")
        ? serverConfig.shellRevealInFileManagerKind === undefined
          ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os, resolve)
          : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind, resolve)
        : undefined,
    canOpenDefault: availableEditors.includes("file-manager"),
    editorIds: availableEditors,
  };

  const activate = async (
    action: FileContextMenuAction,
    target: FileContextMenuTarget,
  ): Promise<void> => {
    if (action === "copy-relative-path" || action === "copy-absolute-path") {
      const path =
        action === "copy-relative-path"
          ? target.filePath
          : resolveFileContextMenuAbsoluteCopyPath(target);
      if (path === null) return;
      const copiedTitle =
        action === "copy-relative-path" ? msg("Relative path copied") : msg("Absolute path copied");
      try {
        const copied = await writeTextToClipboard(path, {
          target: "file path",
          unavailableMessage: msg("Clipboard API is unavailable while copying file path."),
          failureMessage: msg("Failed to copy file path to the clipboard."),
        });
        if (copied) {
          toastManager.add({ type: "success", title: resolve(copiedTitle), description: path });
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: resolve(msg("Failed to copy file path")),
          description: error instanceof Error ? error.message : resolve(msg("An error occurred.")),
        });
      }
      return;
    }
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
          ? resolve(msg("Could not open file"))
          : reveal
            ? resolve(msg("Unable to reveal file"))
            : resolve(
                msg("Could not open in {editor}", {
                  editor: EDITOR_LABEL_BY_ID.get(editor) ?? editor,
                }),
              ),
      description: absolutePath,
    });
  };

  const buildItems = (
    target: FileContextMenuTarget,
  ): readonly ContextMenuItem<FileContextMenuAction>[] =>
    buildFileContextMenuItems({ target, capabilities, resolve });

  const show = async (
    target: FileContextMenuTarget,
    position?: { x: number; y: number },
  ): Promise<void> => {
    const api = readLocalApi();
    const items = buildItems(target);
    if (items.length === 0 || api === undefined) return;
    const clicked = await api.contextMenu.show(items, position);
    if (clicked === null) return;
    await activate(clicked, target);
  };

  return {
    buildItems,
    capabilities,
    activate,
    show,
  };
}

/** Returns an onContextMenu callback that shows the menu at the pointer. */
export function useFileContextMenuHandler(environmentId: EnvironmentId | null) {
  const contextMenu = useFileContextMenu(environmentId);
  return (target: FileContextMenuTarget, event?: { clientX: number; clientY: number }) => {
    void contextMenu.show(target, event ? { x: event.clientX, y: event.clientY } : undefined);
  };
}
